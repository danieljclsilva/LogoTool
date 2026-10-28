/**
 * One-page branded operation-sheet renderer (DOM only).
 *
 * Renders an `OperationSheetView` (pure domain view model) as one branded
 * A4-landscape `.opsheet` page per sheet for the ordinary job, with extra
 * continuation pages only when a sheet truly cannot fit. Photos come from
 * caller-supplied package bytes; artwork composites and dimension arrows are
 * drawn only from caller-evaluated per-sheet overlay bindings
 * (`OperationSheetAssetLookup.getSheetOverlay`, index-aligned with the view)
 * through the exact evaluated photo-mapping math (`artworkPhotoMatrix`).
 * Arrow segments come from the same pure `measurePlacement` result order the
 * view builder prints, so every drawn arrow and its printed `valueMm1`
 * describe the same measurement. Missing mappings, artwork, or dimensions
 * render explicit honest notes \u2014 never guessed overlays, never fabricated
 * numbers.
 *
 * All caller/authored strings reach the page via textContent only. The brand
 * mark arrives as a caller-supplied data URL (`OperationSheetBrand`); a
 * plain "FlexiTog" wordmark renders when none is supplied, and remote URLs
 * never render. This module never reads files, never fetches, never touches
 * the network, so the output stays valid offline over `file://`.
 *
 * `renderOperationDocument` / `operationDocumentStyles` below are deprecated
 * transition shims (the 7-page appendix renderer is retired): they keep the
 * previous export names resolving so existing callers still bundle, but they
 * render an explicit migration notice instead of production content.
 */

import { methodLabel } from '../../../core/decoration-methods/index.js';
import { formatMm1 } from "../../../core/operation-document/index.js";
import type {
  OperationDocument,
  OperationIdentity,
  OperationSheetDimension,
  OperationSheetLogo,
  OperationSheetView,
} from "../../../core/operation-document/types.js";
import { readRasterHeader } from "../../../assets/raster-header.js";
import { artworkPhotoMatrix } from "../../customer-editor/presentation-photo-mapping.js";
import {
  artworkRenderFailureReason,
  bytesToDataUrl,
  type OperationDocumentAssetLookup,
  type OperationSheetAssetLookup,
  type SheetOverlay,
  type SheetOverlayMapping,
} from "./assets.js";
import {
  anchorCode,
  layoutDiagram,
  type DiagramArrowInput,
} from "./diagram-layout.js";

export type { OperationDocumentAssetLookup, OperationSheetAssetLookup };

/** Caller-supplied brand identity. The lead wires the build script to inline
 *  `src/ui/shared/brand/flexitog-mark.jpg` bytes as this data URL. */
export interface OperationSheetBrand {
  markDataUrl: string;
}

/**
 * Genuine content-aware page budgeting (millimetres, A4-landscape print).
 *
 * Every page pays for what it actually carries \u2014 no logo-count quotas, no
 * character-count cliffs. Costs are calibrated from print-width Chromium
 * measurements (1047 px viewport ≈ 277 mm content width; Worker V1 scratch
 * proof) with a 6 mm per-page slop for wrapping variance:
 * - Page frame: header 22 (15 mm mark + job block + rule), footer band 10
 *   (6 band + 4 margin); the legend and trial note are charged per page
 *   from that page's own cards and proof set.
 * - Proofs: figure boxes are CSS-capped (100 mm single-proof stage,
 *   84 mm otherwise) plus a 6 mm caption, so lane stacking never grows a
 *   figure beyond its cap \u2014 the cap is the budget. One or two proofs share
 *   a stage row (the row costs the tallest); 3+ proofs reflow into rows of
 *   three full-width with the cards gridded below. The proof SET is decided
 *   per page by logo relevance (see SheetPlanRelevance): each page budgets
 *   exactly the proofs it renders \u2014 never a sheet-wide flat block \u2014 so
 *   focused sheets never pay for views their cards do not use.
 * - Cards: thumbnail/accent block 26 mm against text lines at 5 mm each
 *   (measured ≈ 5.2 mm/line at print width for 9–11 pt card text). Card
 *   text width is ~32 chars/line in the rail and the grid alike; every
 *   name/size/side/method/param/colour/dimension/unfinished line is
 *   costed, including wrapped dimension lines. Byte-dependent photo notes
 *   are covered by the per-page slop.
 * - Department instructions ride the last page (heading + full-width
 *   lines); a block that fits nowhere gets one explicit branded
 *   instructions page rather than an unplanned print spill.
 * - Rail layout (1–2 proofs on the page) stacks cards beside the proofs:
 *   the stage row costs the taller of the proof column and the card rail.
 *   Grid layout (3+ proofs on the page) stacks proof rows above card rows
 *   of three.
 *
 * Pure; shared verbatim by `operationSheetPageCount` and
 * `renderSheetPages`, so the announced count always equals the rendered
 * pages. Ordinary 1/2/3-view jobs fit one readable page; genuine overflow
 * flows to branded continuation pages that repeat their relevant proofs \u2014
 * a page is never forced by clipping, sub-9pt text, or shrunk labels.
 */
const PAGE_CONTENT_H_MM = 188;
const PAGE_SLOP_MM = 6;
const HEADER_BASE_MM = 5;
const HEADER_MIN_MM = 20;
const TITLE_CPL = 120;
const JOB_CPL = 140;
const BAND_H_MM = 10;
const TRIAL_H_MM = 4;
const LINE_H_MM = 5;
const NAME_LINE_H_MM = 5;
const CARD_PAD_MM = 7;
const CARD_THUMB_H_MM = 26;
const CARD_CPL = 40;
const FULL_CPL = 150;
const INSTRUCTIONS_HEADING_H_MM = 6;
const FIGURE_CAP_1_MM = 100;
const FIGURE_CAP_N_MM = 84;
const FIGURE_CAPTION_MM = 6;
const PROOF_GRID_COLS = 3;
const STAGE_GAP_MM = 4;

function costLines(chars: number, charsPerLine: number): number {
  return Math.max(1, Math.ceil(chars / charsPerLine));
}

/** Estimated card head height: thumbnail block against name/size/side/
 *  method/param/colour lines. Zero-dim cards also carry their one-line
 *  "Dimensions not set" note here, so the head is always complete. */
function cardHeadCostMm(logo: OperationSheetLogo): number {
  const nameLines = costLines(logoHeading(logo).length, CARD_CPL);
  let lines = 3;
  if (logo.methodParams) {
    for (const key of Object.keys(logo.methodParams)) {
      lines += costLines(key.length + 2 + (logo.methodParams[key] ?? "").length, CARD_CPL);
    }
  }
  if (logo.colours && logo.colours.length > 0) {
    lines += costLines(`Colours: ${logo.colours.join(", ")}`.length, CARD_CPL);
  }
  if (logo.dimensions.length === 0) lines += 1;
  return Math.max(CARD_THUMB_H_MM, nameLines * NAME_LINE_H_MM + lines * LINE_H_MM + CARD_PAD_MM);
}

/** Panel line shape mirrors the renderer: ref + value + anchor + edge. */
function dimLineChars(dimension: OperationSheetDimension): number {
  const edge = shortEdge(dimension.toEdge);
  return 2 + 3 + dimension.valueMm1.length + 4 + dimension.fromAnchor.length + 2 + edge.length;
}

/** Estimated header height from wrapped lines: the product/variant title
 *  plus one line per supplied job field. Long names wrap and grow the
 *  header instead of overflowing it; the mark sets the ~21 mm floor. */
function headerCostMm(
  job: OperationSheetView["job"],
  sheet: OperationSheetView["sheets"][number],
): number {
  const title = sheetDisplayTitle(sheet);
  let jobLines = 0;
  for (const field of [job.customer, job.reference, job.article]) {
    if (field) jobLines += costLines(field.length + 11, JOB_CPL);
  }
  return Math.max(HEADER_MIN_MM, HEADER_BASE_MM + costLines(title.length, TITLE_CPL) * NAME_LINE_H_MM + jobLines * LINE_H_MM);
}

/** Instruction paragraph lines: explicit newlines start new lines, so
 *  newline-heavy blocks cost every paragraph instead of collapsing them. */
function instructionParaLines(paragraph: string): number {
  let lines = 0;
  for (const segment of paragraph.split("\n")) lines += costLines(segment.length, FULL_CPL);
  return lines;
}

/** One printable card part: a logo's head block plus a dimension slice.
 *  Long cards continue across pages with clear identity instead of
 *  spilling: the first part carries the head, later parts carry
 *  "CODE (continued)" plus their slice. Refs stay sheet-wide. */
export interface SheetCardPart {
  kind: "card";
  logo: number;
  head: boolean;
  dimsFrom: number;
  dimsTo: number;
}

/** One printable instructions part: a paragraph slice with identity. The
 *  first part carries the section heading, later parts carry it with
 *  "(continued)". */
export interface SheetInstructionsPart {
  kind: "instructions";
  parasFrom: number;
  parasTo: number;
  continued: boolean;
}

export type SheetPagePart = SheetCardPart | SheetInstructionsPart;

export interface SheetPagePlan {
  pages: SheetPagePart[][];
}

/** Estimated part height: head or continued identity plus sliced lines.
 *  Unfinished reasons ride the card's last part; byte-dependent photo
 *  notes ride the per-page slop. */
function partCostMm(
  sheet: OperationSheetView["sheets"][number],
  part: SheetPagePart,
): number {
  if (part.kind === "instructions") {
    let lines = 0;
    for (let p = part.parasFrom; p < part.parasTo; p += 1) {
      lines += instructionParaLines(sheet.instructions[p] ?? "");
    }
    return INSTRUCTIONS_HEADING_H_MM + lines * LINE_H_MM;
  }
  const logo = sheet.logos[part.logo]!;
  let cost = part.head ? cardHeadCostMm(logo) : LINE_H_MM + CARD_PAD_MM;
  for (let d = part.dimsFrom; d < part.dimsTo; d += 1) {
    cost += costLines(dimLineChars(logo.dimensions[d]!), CARD_CPL) * LINE_H_MM;
  }
  if (part.dimsTo === logo.dimensions.length) {
    for (const reason of new Set(logo.unfinished)) cost += costLines(reason.length, CARD_CPL) * LINE_H_MM;
  }
  return cost;
}

/** Estimated anchor-legend height from the distinct anchor names in the
 *  page's own card slices (codes are 1\u20132 characters plus separators). */
function legendCostPartsMm(
  sheet: OperationSheetView["sheets"][number],
  parts: readonly SheetPagePart[],
): number {
  const names = new Set<string>();
  for (const part of parts) {
    if (part.kind !== "card") continue;
    const logo = sheet.logos[part.logo]!;
    for (let d = part.dimsFrom; d < part.dimsTo; d += 1) names.add(logo.dimensions[d]!.fromAnchor);
  }
  if (names.size === 0) return 0;
  let chars = 0;
  for (const name of names) chars += 2 + 3 + name.length + 2;
  return costLines(chars, FULL_CPL) * LINE_H_MM;
}

/** Proof-block height for a proof count on one page (bounds the printable
 *  figures, which never exceed their CSS caps plus caption). */
function proofBlockMm(proofCount: number): number {
  if (proofCount <= 0) return 0;
  if (proofCount === 1) return FIGURE_CAP_1_MM + FIGURE_CAPTION_MM;
  if (proofCount === 2) return FIGURE_CAP_N_MM + FIGURE_CAPTION_MM;
  return Math.ceil(proofCount / PROOF_GRID_COLS) * (FIGURE_CAP_N_MM + FIGURE_CAPTION_MM);
}

/** Estimated stage height for one page: the rail (1\u20132 proofs) costs
 *  the taller of the proof column and the stacked part rail; the grid
 *  (3+ proofs) stacks proof rows above card rows of three. */
function stageCostPartsMm(partHeights: readonly number[], proofCount: number): number {
  if (proofCount <= 2) {
    let rail = 0;
    for (const height of partHeights) rail += height;
    if (partHeights.length > 1) rail += STAGE_GAP_MM * (partHeights.length - 1);
    return Math.max(proofBlockMm(proofCount), rail);
  }
  let grid = 0;
  for (let start = 0; start < partHeights.length; start += PROOF_GRID_COLS) {
    let rowMax = 0;
    for (let j = start; j < Math.min(start + PROOF_GRID_COLS, partHeights.length); j += 1) {
      rowMax = Math.max(rowMax, partHeights[j]!);
    }
    grid += rowMax;
  }
  if (partHeights.length > PROOF_GRID_COLS) {
    grid += STAGE_GAP_MM * (Math.ceil(partHeights.length / PROOF_GRID_COLS) - 1);
  }
  return proofBlockMm(proofCount) + (partHeights.length > 0 ? STAGE_GAP_MM + grid : 0);
}

function pageCostPartsMm(
  sheet: OperationSheetView["sheets"][number],
  job: OperationSheetView["job"],
  parts: readonly SheetPagePart[],
  proofSet: ReadonlySet<number>,
): number {
  // Only card parts ride the stage rail/grid; instruction slices render in
  // the footer below the stage and are costed once via the parts sum.
  // Proof-less instruction-only pages cost no stage at all, matching the
  // renderer (which stages no photos for them).
  const cardHeights = parts.map((part) => part.kind === "card" ? partCostMm(sheet, part) : 0)
    .filter((height) => height > 0);
  let total = headerCostMm(job, sheet) + stageCostPartsMm(cardHeights, proofSet.size) +
    legendCostPartsMm(sheet, parts) + (proofSet.size > 0 ? TRIAL_H_MM : 0) + BAND_H_MM + PAGE_SLOP_MM;
  for (const part of parts) {
    if (part.kind === "instructions") total += partCostMm(sheet, part);
  }
  return total;
}

/**
 * Logo-to-proof relevance for one sheet: which proof (side index) backs
 * each logo, or undefined when the logo binds no printable proof. The
 * renderer derives this from the caller-evaluated overlay (artwork region
 * matched to a mapped side's region); the page counter uses the same
 * helper with caller-supplied asset context when available, and otherwise
 * costs every declared proof on every page (conservative upper bound that
 * never clips \u2014 the lead wires the lookup through at integration for
 * the exact count).
 */
export interface SheetPlanRelevance {
  /** Proof (side index) backing each logo, by logo index. */
  sideOfLogo: (logoIndex: number) => number | undefined;
  /** Proof count used when no logo binds (unmapped sheets). */
  proofCount: number;
  /** Conservative upper bound without asset context: pages that bind
   *  nothing still cost every proof, so the count never under-counts. */
  conservative: boolean;
}

/** Proof set backing one page's parts: relevant proofs only, so focused
 *  sheets never pay for views their cards do not use. Logos binding
 *  nothing contribute no proofs; a page whose parts bind nothing at all
 *  costs the whole block only for a logo-less sheet (which stages every
 *  proof), otherwise nothing (honest proof-less notes instead). */
function proofsOfParts(
  parts: readonly SheetPagePart[],
  relevance: SheetPlanRelevance,
  stageAllProofs: boolean,
): Set<number> {
  const set = new Set<number>();
  for (const part of parts) {
    if (part.kind !== "card") continue;
    const side = relevance.sideOfLogo(part.logo);
    if (side !== undefined) set.add(side);
  }
  if (set.size === 0 && (stageAllProofs || relevance.conservative)) {
    for (let sideIndex = 0; sideIndex < relevance.proofCount; sideIndex += 1) set.add(sideIndex);
  }
  return set;
}

function planSheetPages(
  sheet: OperationSheetView["sheets"][number],
  relevance: SheetPlanRelevance,
  job: OperationSheetView["job"],
): SheetPagePlan {
  const stageAllProofs = sheet.logos.length === 0;
  const pages: SheetPagePart[][] = [[]];
  const fits = (extra: SheetPagePart): boolean =>
    pageCostPartsMm(sheet, job, [...pages[pages.length - 1]!, extra], proofsOfParts([...pages[pages.length - 1]!, extra], relevance, stageAllProofs)) <= PAGE_CONTENT_H_MM;
  const newPage = (): void => {
    pages.push([]);
  };
  const emit = (part: SheetPagePart): void => {
    if (pages[pages.length - 1]!.length > 0 && !fits(part)) newPage();
    // A lone part that still overflows is pathological beyond dim/para
    // granularity (e.g. a megabyte anchor name); it prints unclipped
    // rather than guessed, and the count still matches the render.
    pages[pages.length - 1]!.push(part);
  };
  sheet.logos.forEach((logo, logoIndex) => {
    const dimCount = logo.dimensions.length;
    if (dimCount === 0) {
      emit({ kind: "card", logo: logoIndex, head: true, dimsFrom: 0, dimsTo: 0 });
      return;
    }
    let taken = 0;
    let first = true;
    while (taken < dimCount) {
      if (first) {
        const part: SheetCardPart = { kind: "card", logo: logoIndex, head: true, dimsFrom: taken, dimsTo: taken };
        // Head alone not fitting here starts a fresh page (emitted anyway
        // when even that overflows: residual absurd-input case, counted).
        if (pages[pages.length - 1]!.length > 0 && !fits(part)) newPage();
        // Avoid stranding a dim-less head on a used page: when the head
        // fits here but no dimension does, yet head plus first dimension
        // fits a fresh page, the whole card moves instead — both parts keep
        // clear continued identity either way.
        if (pages[pages.length - 1]!.length > 0 && !fits({ ...part, dimsTo: taken + 1 })) {
          const fresh: SheetPagePart[] = [{ ...part, dimsTo: taken + 1 }];
          if (pageCostPartsMm(sheet, job, fresh, proofsOfParts(fresh, relevance, stageAllProofs)) <= PAGE_CONTENT_H_MM) {
            newPage();
          }
        }
        while (taken < dimCount && fits({ ...part, dimsTo: taken + 1 })) {
          part.dimsTo = taken + 1;
          taken += 1;
        }
        // A head that fits but leaves no room for a dim still makes
        // progress (dims continue next page); a head that fits nowhere is
        // emitted head-only as the documented residual.
        pages[pages.length - 1]!.push(part);
        first = false;
      } else {
        const part: SheetCardPart = { kind: "card", logo: logoIndex, head: false, dimsFrom: taken, dimsTo: taken };
        if (pages[pages.length - 1]!.length > 0 && !fits(part)) newPage();
        while (taken < dimCount && fits({ ...part, dimsTo: taken + 1 })) {
          part.dimsTo = taken + 1;
          taken += 1;
        }
        if (part.dimsTo === part.dimsFrom) {
          // A single dimension line always fits a fresh page at readable
          // sizes; forcing one guarantees progress without clipping.
          part.dimsTo = taken + 1;
          taken += 1;
        }
        pages[pages.length - 1]!.push(part);
      }
    }
  });
  let p = 0;
  while (p < sheet.instructions.length) {
    // Never emit an empty part: when at least one paragraph fits alongside,
    // stay; otherwise start a fresh page (which always takes at least one
    // paragraph by the residual rule below, so progress is guaranteed).
    if (pages[pages.length - 1]!.length > 0) {
      const probe: SheetInstructionsPart = { kind: "instructions", parasFrom: p, parasTo: p + 1, continued: p > 0 };
      if (!fits(probe)) newPage();
    }
    const part: SheetInstructionsPart = { kind: "instructions", parasFrom: p, parasTo: p, continued: p > 0 };
    while (p < sheet.instructions.length && fits({ ...part, parasTo: p + 1 })) {
      part.parasTo = p + 1;
      p += 1;
    }
    if (part.parasTo === part.parasFrom) {
      // A single paragraph that fits nowhere alone is emitted whole
      // (documented residual, counted, never clipped).
      part.parasTo = p + 1;
      p += 1;
    }
    pages[pages.length - 1]!.push(part);
  }
  return { pages };
}
/**
 * Focused-print side indices shared by the planner and the renderer.
 *
 * Photo sides print only when the overlay maps them AND at least one
 * artwork entry carries that mapping's region. Model sides always print:
 * the capture already composites the committed-revision artwork, so the
 * figure is either the current render or an explicit pending note — never
 * a guessed overlay. Pure; no DOM.
 */
function printableSideIndices(
  sheet: OperationSheetView["sheets"][number],
  overlay: SheetOverlay | undefined,
): number[] {
  const printable: number[] = [];
  sheet.sides.forEach((side, sideIndex) => {
    if (side.kind === "model") {
      printable.push(sideIndex);
      return;
    }
    const sideMapping = overlay?.mappings[sideIndex];
    if (
      sideMapping !== undefined &&
      overlay !== undefined &&
      overlay.artworks.some((entry) => entry !== undefined && entry.regionId === sideMapping.regionId)
    ) {
      printable.push(sideIndex);
    }
  });
  return printable;
}

/**
 * Planner relevance for one sheet: logo-to-proof bindings from the
 * caller-evaluated overlay (artwork region matched to a mapped printable
 * side's region), plus model-view bindings (artwork region matched to a
 * printable model side's explicit regions), or the conservative declared
 * fallback without asset context. Shared verbatim by the counter and the
 * renderer.
 */
function relevanceForSheet(
  sheet: OperationSheetView["sheets"][number],
  sheetIndex: number,
  lookup: OperationSheetAssetLookup | undefined,
): SheetPlanRelevance {
  const overlay = lookup?.getSheetOverlay?.(sheetIndex);
  if (overlay === undefined) return declaredRelevance(sheet);
  const printable = printableSideIndices(sheet, overlay);
  return {
    proofCount: printable.length,
    conservative: false,
    sideOfLogo: (logoIndex: number): number | undefined => {
      const art = overlay.artworks[logoIndex];
      if (!art) return undefined;
      const photo = printable.find((sideIndex) => overlay.mappings[sideIndex]?.regionId === art.regionId);
      if (photo !== undefined) return photo;
      return printable.find((sideIndex) => {
        const side = sheet.sides[sideIndex];
        return side !== undefined && side.kind === "model"
          && (side.regions ?? []).includes(art.regionId);
      });
    },
  };
}

/**
 * View-only relevance fallback for the page counter without asset context:
 * every declared proof is costed on every page. Conservative (never clips),
 * exact for single-proof sheets; the lead passes the asset lookup at
 * integration for the exact multi-proof count.
 */
function declaredRelevance(sheet: OperationSheetView["sheets"][number]): SheetPlanRelevance {
  return {
    sideOfLogo: () => undefined,
    proofCount: sheet.sides.length,
    conservative: true,
  };
}

/** Independent version guard: never guess-render an unknown contract. */
const SHEET_VIEW_VERSION = "operation-sheet-view/1";

function isSheetView(value: unknown): value is OperationSheetView {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate["version"] === SHEET_VIEW_VERSION && Array.isArray(candidate["sheets"]);
}

function setText(element: HTMLElement | SVGElement, text: string): void {
  element.textContent = text;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function createTextElement<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  text: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = createElement(document, tag, className);
  setText(element, text);
  return element;
}

/** classList-free class append (works on minimal DOM shims and real DOM). */
function addClass(element: HTMLElement | SVGElement, cls: string): void {
  const current = element.getAttribute("class") ?? "";
  element.setAttribute("class", current.length === 0 ? cls : `${current} ${cls}`);
}

/** SVG namespace element factory (the typed helper only covers HTML tags). */
function createSvgElement(document: Document, tag: string, className?: string): SVGElement {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag) as SVGElement;
  if (className) element.setAttribute("class", className);
  return element;
}

function setSvgAttributes(element: SVGElement, attributes: Record<string, string>): void {
  for (const key of Object.keys(attributes)) element.setAttribute(key, attributes[key]!);
}

/**
 * Header-valid bytes can still fail native decoding (truncated or corrupt
 * payload behind a valid header). Every rendered raster <img> carries an
 * error listener that swaps the figure for explicit placeholder text, so a
 * corrupt payload never renders a broken image and never throws.
 */
function watchImageDecode(
  document: Document,
  figure: HTMLElement,
  image: HTMLImageElement,
  uri: string,
): void {
  image.addEventListener("error", () => {
    figure.replaceChildren();
    figure.append(createTextElement(document, "p", artworkRenderFailureReason("decode-failed", uri), "opsheet-placeholder"));
  });
}

/** Same decode-failure honesty for an SVG <image> node: drop the node and
 *  leave an explicit note instead of a silently missing overlay. */
function watchSvgImage(
  document: Document,
  figure: HTMLElement,
  node: SVGElement,
  note: string,
): void {
  node.addEventListener("error", () => {
    node.remove();
    figure.append(createTextElement(document, "p", note, "opsheet-photo-note"));
  });
}

/** Same decode-failure honesty for a card thumbnail: drop only the
 *  thumbnail node and leave an explicit note instead of a silently missing
 *  logo \u2014 the rest of the card (size, dimensions) stays intact. */
function watchThumbImage(
  document: Document,
  panel: HTMLElement,
  node: HTMLImageElement,
  note: string,
): void {
  node.addEventListener("error", () => {
    node.remove();
    panel.append(createTextElement(document, "p", note, "opsheet-photo-note"));
  });
}

/**
 * Resolved logo thumbnail for one card: validated raster bytes as an inert
 * data URL plus the header pixel size (kept so the card preserves the
 * aspect ratio with `object-fit: contain` instead of cropping). Alpha and
 * backgrounds pass through untouched.
 */
interface CardThumb {
  url: string;
  width: number;
  height: number;
}

/**
 * Look up the card thumbnail for one logo through the caller-evaluated
 * overlay (`overlay.artworks[logoIndex].imagePath`), header-validated with
 * the existing `readRasterHeader` + `bytesToDataUrl` path. Returns the
 * renderable thumbnail, or null plus an honest panel-note reason when the
 * artwork is absent or undecodable \u2014 never a fake box. `logoKey` names the
 * operator key (business code) so notes never echo internal logo names.
 * Pure; no DOM.
 */
function resolveCardThumb(
  lookup: OperationSheetAssetLookup | undefined,
  overlay: SheetOverlay | undefined,
  logoIndex: number,
  logoKey: string,
): { thumb: CardThumb | null; note: string | null } {
  const art = overlay?.artworks[logoIndex];
  if (!art || art.imagePath === undefined) {
    return {
      thumb: null,
      note: `Logo thumbnail not supplied for \u201c${logoKey}\u201d; size and dimensions below still apply.`,
    };
  }
  const bytes = lookup?.getBytes(art.imagePath);
  if (!bytes || bytes.length === 0) {
    return {
      thumb: null,
      note: `Logo thumbnail unavailable: \u201c${art.imagePath}\u201d has no bytes in the package; size and dimensions below still apply.`,
    };
  }
  const header = readRasterHeader(bytes);
  if (!header) {
    return {
      thumb: null,
      note: `Logo thumbnail unavailable: \u201c${art.imagePath}\u201d is not a decodable raster (PNG, JPEG or WebP only); size and dimensions below still apply.`,
    };
  }
  const url = bytesToDataUrl(bytes, header.mediaType);
  if (!url) {
    return {
      thumb: null,
      note: `Logo thumbnail unavailable: \u201c${art.imagePath}\u201d could not be encoded for display; size and dimensions below still apply.`,
    };
  }
  return { thumb: { url, width: header.width, height: header.height }, note: null };
}

const SAFE_DATA_URL_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

function safeDataUrl(url: string | undefined): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  return SAFE_DATA_URL_PATTERN.test(url) ? url : null;
}

function sheetDisplayTitle(sheet: OperationSheetView["sheets"][number]): string {
  const base = sheet.productName ?? sheet.productId;
  // variantDisplay is the operator-facing variant label (human name,
  // `Option N`, or null to omit a single unnamed option). Raw variant ids
  // never reach operator surfaces; diagnostics keep the exact ids.
  if (sheet.variantDisplay === null) return base;
  if (sheet.variantDisplay !== undefined) return `${base} / ${sheet.variantDisplay}`;
  return `${base} / ${sheet.variantName ?? sheet.variantId}`;
}

function sheetTitle(sheet: OperationSheetView["sheets"][number]): string {
  return sheetDisplayTitle(sheet);
}

function logoHeading(logo: OperationSheetLogo): string {
  // The business code alone is the operator's key whenever it was
  // explicitly supplied (code !== name); otherwise the single display
  // identity. Never the raw customer logo id (the view never carries it).
  return logo.logoCode !== logo.logoName ? logo.logoCode : logo.logoName;
}

/**
 * Printed page count for a view: one page per sheet, plus continuation
 * pages only when a sheet's logo panels truly overflow. Zero sheets still
 * yield one honest empty page. Pure; no DOM.
 */
/**
 * Printed page count for a view: one page per sheet, plus continuation
 * pages only when a sheet's content truly overflows. Shares
 * `planSheetPages` with the renderer, so the announced count always equals
 * the rendered pages when both see the same asset context: pass the same
 * lookup the renderer gets for the exact count; without it the counter
 * costs every declared proof on every page (conservative upper bound that
 * never clips \u2014 the lead wires the lookup through at integration).
 * Pure; no DOM.
 */
export function operationSheetPageCount(view: OperationSheetView, lookup?: OperationSheetAssetLookup): number {
  if (!isSheetView(view) || view.sheets.length === 0) return 1;
  let pages = 0;
  view.sheets.forEach((sheet, sheetIndex) => {
    const plan = planSheetPages(sheet, relevanceForSheet(sheet, sheetIndex, lookup), view.job);
    pages += plan.pages.length;
  });
  return pages;
}

/**
 * Amount/selection summary shown before print so no product/variant is
 * silently lost. Pure; no DOM.
 */
export function operationSheetSummary(view: OperationSheetView): string {
  if (!isSheetView(view) || view.sheets.length === 0) return "0 operation sheets \u2014 nothing to print.";
  if (view.sheets.length === 1) return `1 operation sheet \u2014 ${sheetTitle(view.sheets[0]!)}`;
  return `${view.sheets.length} operation sheets \u2014 ${view.sheets.map(sheetTitle).join("; ")}`;
}

function renderSheetHeader(
  document: Document,
  view: OperationSheetView,
  sheetIndex: number,
  brand: OperationSheetBrand | undefined,
  continued: boolean,
): HTMLElement {
  const sheet = view.sheets[sheetIndex]!;
  const header = createElement(document, "header", "opsheet-header");
  const markUrl = safeDataUrl(brand?.markDataUrl);
  if (markUrl) {
    const mark = createElement(document, "img", "opsheet-mark");
    mark.setAttribute("src", markUrl);
    mark.setAttribute("alt", "FlexiTog");
    header.append(mark);
  } else {
    header.append(createTextElement(document, "span", "FlexiTog", "opsheet-brand-wordmark"));
  }
  const titles = createElement(document, "div", "opsheet-titles");
  titles.append(createTextElement(
    document,
    "h1",
    continued ? `${sheetTitle(sheet)} (continued)` : sheetTitle(sheet),
    "opsheet-title",
  ));
  const job = view.job;
  if (job.customer) titles.append(createTextElement(document, "p", `Customer: ${job.customer}`, "opsheet-job-line"));
  if (job.reference) titles.append(createTextElement(document, "p", `Reference: ${job.reference}`, "opsheet-job-line"));
  if (job.article) titles.append(createTextElement(document, "p", `Article: ${job.article}`, "opsheet-job-line"));
  header.append(titles);
  return header;
}

/** Forward-map one region-frame mm point to photo pixels. Null on any
 *  non-finite input (the caller then omits the arrow, never guesses). */
function forwardToPhoto(
  transform: SheetOverlayMapping["transform"],
  photoWidth: number,
  photoHeight: number,
  xMm: number,
  yMm: number,
): { x: number; y: number } | null {
  for (const value of [transform.a, transform.b, transform.c, transform.d, transform.e, transform.f,
    photoWidth, photoHeight, xMm, yMm]) {
    if (!Number.isFinite(value)) return null;
  }
  if (!(photoWidth > 0) || !(photoHeight > 0)) return null;
  const u = transform.a * xMm + transform.b * yMm + transform.c;
  const v = transform.d * xMm + transform.e * yMm + transform.f;
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  return { x: u * photoWidth, y: v * photoHeight };
}

/** Arrows are drawn only while both ends land on the photo (small tolerance
 *  for rounding at the very edge). Anything else stays in the logo panel as
 *  pure-mm text with an explicit "not shown on photo" note. */
function onPhoto(photoWidth: number, photoHeight: number, point: { x: number; y: number }): boolean {
  const u = point.x / photoWidth;
  const v = point.y / photoHeight;
  return u >= -0.02 && u <= 1.02 && v >= -0.02 && v <= 1.02;
}

/** Guard for an overlay arrow endpoint: finite region-frame millimetres. */
function isPhotoPoint(point: unknown): point is { x: number; y: number } {
  if (typeof point !== "object" || point === null) return false;
  const candidate = point as Record<string, unknown>;
  return typeof candidate["x"] === "number" && Number.isFinite(candidate["x"]) &&
    typeof candidate["y"] === "number" && Number.isFinite(candidate["y"]);
}

/**
 * Compose the visible detail line from the measured `toEdge` text: strip one
 * leading "to " (the line template supplies its own) and remove technical
 * axis-tag groups (" (…min-X…)" style only). Explanatory parentheses such as
 * "(nearest point on that edge)" are kept. No words invented; binding labels
 * print verbatim.
 */
function cleanToEdge(toEdge: string): string {
  const withoutLeadingTo = toEdge.startsWith("to ") ? toEdge.slice("to ".length) : toEdge;
  return withoutLeadingTo.replace(/\s*\(([^()]*(?:min|max)-[XY][^()]*)\)/g, "").trim();
}

/**
 * One concise edge phrase for the single dimension line, derived from the
 * measured `toEdge` text (core strings untouched): touching
 * ("the {E} artwork edge … measured horizontally|vertically") becomes
 * "{E} edge, horizontal|vertical"; extended ("supporting line extended
 * beyond … ({E} edge …), measured …") becomes "{E} edge, {A}
 * (extended)" \u2014 trailing qualifier so the lead e2e `edge, horizontal`
 * substring still matches while retaining the marker;
 * shortest ("nearest point on that edge", edge word from "distance to
 * the {E} edge") becomes "{E} edge (nearest)".
 * Anything else falls back to the cleaned `toEdge` verbatim (never worse
 * than today). No words invented; binding labels print verbatim.
 */
function shortEdge(toEdge: string): string {
  const axisWord = (word: string): string => (word === "horizontally" ? "horizontal" : "vertical");
  const touching = /the (\w+) artwork edge/.exec(toEdge);
  const measured = /measured (horizontally|vertically)/.exec(toEdge);
  if (touching && measured) return `${touching[1]} edge, ${axisWord(measured[1]!)}`;
  if (toEdge.includes("supporting line extended beyond")) {
    const edgeWord = /\((\w+) edge/.exec(toEdge);
    if (edgeWord && measured) return `${edgeWord[1]} edge, ${axisWord(measured[1]!)} (extended)`;
    return cleanToEdge(toEdge);
  }
  const nearest = /nearest point on that edge/.exec(toEdge);
  if (nearest) {
    const edgeWord = /distance to the (\w+) edge/.exec(toEdge);
    return `${edgeWord ? edgeWord[1] : "artwork"} edge (nearest)`;
  }
  return cleanToEdge(toEdge);
}

/**
 * One garment photo as a fixed exterior-lane technical diagram: the photo
 * plus mapped artwork composite untouched inside a nested photo frame, with
 * every dimension line, value label, and anchor name OUTSIDE the photo
 * pixels in white gutters above (horizontal) and beside (vertical) it.
 * Only 1–2 character anchor codes ever render over the photo rect.
 * Per-logo fallback notes accumulate into `perLogo` for the logo panels.
 * `anchorCodes` assigns stable per-sheet letter codes in first-appearance
 * order (shared across the sheet's sides). `refStarts` carries the
 * sheet-wide 1-based dimension reference per logo (logo 1 owns 1..N, logo 2
 * continues), so gutter labels and panel lines share one numbering that
 * never restarts per logo. Never guesses.
 */
/**
 * One model-view figure: the locally captured clean product render (no
 * handles, overlays or controls) with applied artwork from the committed
 * revision the lookup was built for. The capture already composites the
 * artwork, so no mapping math runs here and no gutter arrows are drawn —
 * measured dimensions stay in the logo panels as pure-mm text. A missing
 * render prints one explicit pending note, never a guessed image. Pure
 * data flow; no DOM beyond the figure itself.
 */
function renderModelFigure(
  document: Document,
  sideLabel: string,
  imagePath: string,
  lookup: OperationSheetAssetLookup | undefined,
): HTMLElement {
  const figure = createElement(document, "figure", "opsheet-photo opsheet-model-photo");
  const render = lookup?.getModelViewImage?.(imagePath);
  const url = render?.dataUrl;
  const safe = typeof url === "string" && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url);
  if (render && safe && Number.isFinite(render.width) && render.width > 0
    && Number.isFinite(render.height) && render.height > 0) {
    const image = createElement(document, "img", "opsheet-photo-img");
    image.setAttribute("src", url as string);
    image.setAttribute("alt", `${sideLabel}: model view with applied artwork`);
    image.setAttribute("width", String(render.width));
    image.setAttribute("height", String(render.height));
    watchImageDecode(document, figure, image, imagePath);
    figure.append(image);
  } else {
    figure.append(createTextElement(
      document,
      "p",
      `Model view \u201c${sideLabel}\u201d is not rendered yet \u2014 capture it from the 3D model; dimensions below are the source of truth.`,
      "opsheet-placeholder",
    ));
  }
  const caption = createElement(document, "figcaption", "opsheet-caption");
  setText(caption, sideLabel);
  figure.append(caption);
  return figure;
}

function renderSideFigure(
  document: Document,
  view: OperationSheetView,
  sheetIndex: number,
  sideIndex: number,
  lookup: OperationSheetAssetLookup | undefined,
  perLogo: string[][],
  anchorCodes: Map<string, string>,
  markerSeed: { next: number },
  refStarts: readonly number[],
  occurrence: number,
  legendSink: Array<{ code: string; name: string }> | undefined,
  logoFilter: ReadonlyMap<number, { dimsFrom: number; dimsTo: number }> | null,
): HTMLElement {
  const sheet = view.sheets[sheetIndex]!;
  const side = sheet.sides[sideIndex]!;
  const figure = createElement(document, "figure", "opsheet-photo");
  const sideLabel = side.label ?? side.view ?? "Product photo";
  if (side.kind === "model") {
    return renderModelFigure(document, sideLabel, side.imagePath, lookup);
  }

  const photoBytes = lookup?.getBytes(side.imagePath);
  const photoHeader = photoBytes && photoBytes.length > 0 ? readRasterHeader(photoBytes) : null;
  const photoUrl = photoBytes && photoHeader ? bytesToDataUrl(photoBytes, photoHeader.mediaType) : null;

  const plainPhoto = (note: string | null): HTMLElement => {
    if (photoUrl && photoHeader) {
      const image = createElement(document, "img", "opsheet-photo-img");
      image.setAttribute("src", photoUrl);
      image.setAttribute("alt", `${sideLabel}: product photo (reference only, unmapped)`);
      image.setAttribute("width", String(photoHeader.width));
      image.setAttribute("height", String(photoHeader.height));
      watchImageDecode(document, figure, image, side.imagePath);
      figure.append(image);
    } else {
      figure.append(createTextElement(
        document,
        "p",
        photoBytes && photoBytes.length > 0
          ? artworkRenderFailureReason("encode-failed", side.imagePath)
          : `Product photo unavailable: \u201c${side.imagePath}\u201d has no bytes in the package; dimensions below are the source of truth.`,
        "opsheet-placeholder",
      ));
    }
    const caption = createElement(document, "figcaption", "opsheet-caption");
    setText(caption, sideLabel);
    figure.append(caption);
    if (note !== null) {
      figure.append(createTextElement(document, "p", note, "opsheet-photo-note"));
    }
    return figure;
  };

  const overlay = lookup?.getSheetOverlay?.(sheetIndex);
  const mapping = overlay?.mappings[sideIndex];
  if (!mapping) {
    return plainPhoto("reference only, unmapped \u2014 setup needed.");
  }
  if (!photoUrl || !photoHeader) {
    return plainPhoto(null);
  }

  // Composite only the page's own logos that actually render: header-valid
  // bytes plus a non-degenerate artwork-on-photo matrix. `logoFilter`
  // scopes a repeated proof to its page's dim slices, so a continuation
  // shows exactly its own cards' dimensions and never another page's.
  // Anything else falls back to the honest reference-only photo below.
  const width = photoHeader.width;
  const height = photoHeader.height;
  const rendered: Array<{ url: string; matrix: { a: number; b: number; c: number; d: number; e: number; f: number } }> = [];
  sheet.logos.forEach((logo, logoIndex) => {
    if (logoFilter !== null && logoFilter.get(logoIndex) === undefined) return;
    const art = overlay.artworks[logoIndex];
    if (!art || art.regionId !== mapping.regionId) return;
    if (art.imagePath === undefined) {
      perLogo[logoIndex]?.push(
        `Artwork overlay not shown on ${sideLabel}: no renderable artwork supplied for \u201c${logoHeading(logo)}\u201d; size and dimensions below still apply.`,
      );
      return;
    }
    const artBytes = lookup?.getBytes(art.imagePath);
    const artHeader = artBytes && artBytes.length > 0 ? readRasterHeader(artBytes) : null;
    const artUrl = artBytes && artHeader ? bytesToDataUrl(artBytes, artHeader.mediaType) : null;
    const matrix = artworkPhotoMatrix(mapping.transform, width, height, {
      xMm: art.xMm,
      yMm: art.yMm,
      widthMm: art.widthMm,
      heightMm: art.heightMm,
      rotationDeg: art.rotationDeg,
    });
    if (artUrl && matrix) {
      rendered.push({ url: artUrl, matrix });
    } else {
      perLogo[logoIndex]?.push(
        `Artwork overlay not shown on ${sideLabel}: artwork bytes for \u201c${logoHeading(logo)}\u201d are missing or undecodable; size and dimensions below still apply.`,
      );
    }
  });
  if (rendered.length === 0) {
    return plainPhoto("reference only (no artwork overlay could be rendered from the supplied bytes).");
  }

  // Forward-map every overlay arrow segment to true photo-pixel points.
  // Physical values shown are the view's own `valueMm1` strings (pure mm);
  // the segments only position the arrows. Unpositionable arrows stay in
  // the panels with an explicit note. `ref` is the sheet-wide 1-based
  // dimension reference shared by the gutter label and the panel line
  // (logo 1 owns 1..N, logo 2 continues \u2014 never restarted per logo).
  interface DrawableArrow {
    ref: number;
    valueMm1: string;
    p0: { x: number; y: number };
    p1: { x: number; y: number };
    artwork: { x: number; y: number } | null;
    anchorKey: string;
  }
  const drawable: DrawableArrow[] = [];
  sheet.logos.forEach((logo, logoIndex) => {
    const slice = logoFilter?.get(logoIndex);
    if (logoFilter !== null && slice === undefined) return;
    const art = overlay.artworks[logoIndex];
    if (!art || art.regionId !== mapping.regionId) return;
    const dimsFrom = slice?.dimsFrom ?? 0;
    const dimsTo = slice?.dimsTo ?? logo.dimensions.length;
    logo.dimensions.forEach((dimension, dimensionIndex) => {
      if (dimensionIndex < dimsFrom || dimensionIndex >= dimsTo) return;
      const raw = art.arrows?.[dimensionIndex];
      if (!raw || !isPhotoPoint(raw.p0) || !isPhotoPoint(raw.p1)) return;
      const p0 = forwardToPhoto(mapping.transform, width, height, raw.p0.x, raw.p0.y);
      const p1 = forwardToPhoto(mapping.transform, width, height, raw.p1.x, raw.p1.y);
      if (!p0 || !p1 || !onPhoto(width, height, p0) || !onPhoto(width, height, p1)) {
        perLogo[logoIndex]?.push(
          `Dimension \u201c${dimension.label}\u201d (${dimension.valueMm1} mm) is not drawn on ${sideLabel} \u2014 it falls outside the mapped photo.`,
        );
        return;
      }
      const ext = raw.artworkPoint;
      const pe = ext && isPhotoPoint(ext) ? forwardToPhoto(mapping.transform, width, height, ext.x, ext.y) : null;
      drawable.push({
        ref: (refStarts[logoIndex] ?? 1) + dimensionIndex,
        valueMm1: dimension.valueMm1,
        p0,
        p1,
        artwork: pe && onPhoto(width, height, pe) ? pe : null,
        anchorKey: `${dimension.fromAnchor}|${Math.round(p1.x * 1e9)}|${Math.round(p1.y * 1e9)}`,
      });
    });
  });

  // Fixed diagram space: allocated photo rectangle plus white dimension
  // lanes above and beside it. Pure layout math lives in the helper; the
  // millimetre values and logo placements are never transformed.
  const gutterInputs: DiagramArrowInput[] = drawable.map((arrow) => ({
    p0: arrow.p0,
    p1: arrow.p1,
    label: `${arrow.ref} \u00b7 ${arrow.valueMm1} mm`,
  }));
  const layout = layoutDiagram(width, height, gutterInputs);
  if (!layout) {
    return plainPhoto(null);
  }

  const svg = createSvgElement(document, "svg", "opsheet-photo-svg");
  svg.setAttribute("viewBox", `0 0 ${layout.viewW} ${layout.viewH}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${sideLabel}: mapped photo proof with applied logo artwork and measured dimension arrows (photo trial overlay).`);
  // Arrowheads, defined once per figure occurrence: one marker serves both
  // ends via auto-start-reverse. Sizes are print-safe drawing units (see the
  // layout helper's print-cap derivation), never scaled measurement. The
  // occurrence suffix keeps repeated proofs of one side (continuation
  // pages) free of duplicate element ids.
  const markerId = `opsheet-ah-${sheetIndex}-${sideIndex}-${occurrence}`;
  const defs = createSvgElement(document, "defs");
  const marker = createSvgElement(document, "marker");
  setSvgAttributes(marker, {
    id: markerId,
    markerWidth: String(layout.markerSize),
    markerHeight: String(layout.markerSize),
    refX: String(layout.markerSize * 0.85),
    refY: String(layout.markerSize / 2),
    orient: "auto-start-reverse",
    markerUnits: "userSpaceOnUse",
  });
  const head = createSvgElement(document, "path");
  setSvgAttributes(head, {
    d: `M0,0 L${layout.markerSize},${layout.markerSize / 2} L0,${layout.markerSize} z`,
    fill: "#111",
  });
  marker.append(head);
  defs.append(marker);
  svg.append(defs);

  // Photo block: the nested frame carries the photo and artwork overlays
  // with the exact current mapping math (`preserveAspectRatio="none"`, same
  // decode-failure handling). Photo bytes and aspect are untouched.
  const frame = createSvgElement(document, "svg", "opsheet-photo-frame");
  setSvgAttributes(frame, {
    x: String(layout.frameX),
    y: String(layout.top),
    width: String(width),
    height: String(height),
    viewBox: `0 0 ${width} ${height}`,
  });
  const photo = createSvgElement(document, "image");
  setSvgAttributes(photo, { href: photoUrl, x: "0", y: "0", width: String(width), height: String(height) });
  frame.append(photo);
  watchSvgImage(document, figure, photo, `Product photo \u201c${side.imagePath}\u201d could not be decoded; dimensions below are the source of truth.`);
  for (const art of rendered) {
    const node = createSvgElement(document, "image", "opsheet-artwork-overlay");
    setSvgAttributes(node, {
      href: art.url,
      x: "0",
      y: "0",
      width: "1",
      height: "1",
      preserveAspectRatio: "none",
      transform: `matrix(${art.matrix.a} ${art.matrix.b} ${art.matrix.c} ${art.matrix.d} ${art.matrix.e} ${art.matrix.f})`,
    });
    frame.append(node);
    watchSvgImage(document, figure, node, "An artwork overlay could not be decoded and was omitted.");
  }
  svg.append(frame);

  // Dimension lines live in the gutters only, with arrowheads on both ends
  // and witness segments back to each true mapped point. The dashed
  // off-artwork extension links the extreme artwork corner to the line
  // start; shortest-to-edge keeps its true finite-edge value (values are
  // never touched \u2014 only drawing coordinates). A zero-length measurement
  // draws NO arrow line: one small open circle marks the true point and a
  // leader links the gutter value label to it (the panel states the 0.0).
  drawable.forEach((arrow, arrowIndex) => {
    const lane = layout.arrows[arrowIndex]!;
    if (lane.coincident) {
      const dot = createSvgElement(document, "circle");
      setSvgAttributes(dot, {
        cx: String(lane.x1),
        cy: String(lane.y1),
        r: String(layout.coincidentR),
        fill: "none",
        stroke: "#111",
        "stroke-width": String(layout.strokeWitness),
      });
      svg.append(dot);
      const leader = createSvgElement(document, "line", "opsheet-witness");
      setSvgAttributes(leader, {
        x1: String(lane.w0.x1),
        y1: String(lane.w0.y1),
        x2: String(lane.w0.x2),
        y2: String(lane.w0.y2),
        "stroke-width": String(layout.strokeWitness),
      });
      svg.append(leader);
    } else {
      const line = createSvgElement(document, "line", "opsheet-arrow");
      setSvgAttributes(line, {
        x1: String(lane.x1),
        y1: String(lane.y1),
        x2: String(lane.x2),
        y2: String(lane.y2),
        "marker-start": `url(#${markerId})`,
        "marker-end": `url(#${markerId})`,
        "stroke-width": String(layout.strokeArrow),
      });
      if (arrow.artwork) {
        const link = createSvgElement(document, "line", "opsheet-arrow-extension");
        setSvgAttributes(link, {
          x1: String(layout.frameX + arrow.artwork.x),
          y1: String(layout.top + arrow.artwork.y),
          x2: String(lane.x1),
          y2: String(lane.y1),
          "stroke-width": String(layout.strokeWitness),
        });
        svg.append(link);
      }
      svg.append(line);
      for (const witness of [lane.w0, lane.w1]) {
        const segment = createSvgElement(document, "line", "opsheet-witness");
        setSvgAttributes(segment, {
          x1: String(witness.x1),
          y1: String(witness.y1),
          x2: String(witness.x2),
          y2: String(witness.y2),
          "stroke-width": String(layout.strokeWitness),
        });
        svg.append(segment);
      }
    }
    const label = createSvgElement(document, "text", "opsheet-dim-label");
    const labelAttributes: Record<string, string> = {
      x: String(lane.lx),
      y: String(lane.ly),
      "font-size": String(layout.fontPx),
      "text-anchor": "middle",
    };
    if (lane.rotate) {
      labelAttributes["transform"] = `rotate(-90 ${lane.lx} ${lane.ly})`;
    }
    setSvgAttributes(label, labelAttributes);
    setText(label, `${arrow.ref} \u00b7 ${arrow.valueMm1} mm`);
    svg.append(label);
  });

  // Short anchor markers at each true anchor point (small circle + 1–2
  // character code, assigned per sheet in first-appearance order). Full
  // anchor names live only in the per-logo panel lines. One marker per
  // distinct anchor point.
  const drawnAnchors = new Set<string>();
  for (const arrow of drawable) {
    if (drawnAnchors.has(arrow.anchorKey)) continue;
    drawnAnchors.add(arrow.anchorKey);
    let code = anchorCodes.get(arrow.anchorKey);
    if (code === undefined) {
      code = anchorCode(markerSeed.next);
      markerSeed.next += 1;
      anchorCodes.set(arrow.anchorKey, code);
    }
    const separator = arrow.anchorKey.indexOf("|");
    legendSink?.push({
      code,
      name: separator < 0 ? arrow.anchorKey : arrow.anchorKey.slice(0, separator),
    });
    const group = createSvgElement(document, "g", "opsheet-anchor-marker");
    const dot = createSvgElement(document, "circle");
    setSvgAttributes(dot, {
      cx: String(layout.frameX + arrow.p1.x),
      cy: String(layout.top + arrow.p1.y),
      r: String(layout.anchorR),
    });
    group.append(dot);
    const tag = createSvgElement(document, "text");
    setSvgAttributes(tag, {
      x: String(layout.frameX + arrow.p1.x),
      y: String(layout.top + arrow.p1.y),
      "font-size": String(layout.fontPx * 0.9),
      "text-anchor": "middle",
      "dominant-baseline": "central",
    });
    setText(tag, code);
    group.append(tag);
    svg.append(group);
  }
  figure.append(svg);

  const caption = createElement(document, "figcaption", "opsheet-caption");
  setText(caption, sideLabel);
  figure.append(caption);
  return figure;
}

/**
 * One card part: the head block (thumbnail, name, size, side, method,
 * params, colours) only on the card's first part, then this part's
 * dimension slice with sheet-wide refs. Only a whole card keeps the plain
 * heading; every other part reads "CODE (continued)". Unfinished reasons
 * and photo notes ride the card's last part (slice reaching the final
 * dimension). Every logo card prints exactly once in total across its
 * parts — parts never duplicate content.
 */
function renderCardPart(
  document: Document,
  logo: OperationSheetLogo,
  photoNotes: string[],
  refStart: number,
  thumb: CardThumb | null,
  thumbNote: string | null,
  part: SheetCardPart,
  isLastPart: boolean,
): HTMLElement {
  const panel = createElement(document, "article", "opsheet-logo");
  panel.append(createTextElement(document, "span", String(part.logo + 1), "opsheet-logo-number"));
  // A card split across pages carries continued identity on every part
  // except a whole card: a stranded head, a middle slice, and the tail all
  // read "CODE (continued)" so no part poses as the complete card.
  const heading = part.head && isLastPart ? logoHeading(logo) : `${logoHeading(logo)} (continued)`;
  if (part.head) {
    if (thumb) {
      const image = createElement(document, "img", "opsheet-card-thumb");
      image.setAttribute("src", thumb.url);
      image.setAttribute("width", String(thumb.width));
      image.setAttribute("height", String(thumb.height));
      // Alt names the operator key (business code), never the raw logo name.
      image.setAttribute("alt", `${logoHeading(logo)}: logo artwork thumbnail`);
      watchThumbImage(
        document,
        panel,
        image,
        `Logo thumbnail for \u201c${logoHeading(logo)}\u201d could not be decoded; size and dimensions below still apply.`,
      );
      panel.append(image);
    }
    if (thumbNote !== null) {
      panel.append(createTextElement(document, "p", thumbNote, "opsheet-photo-note"));
    }
  }
  panel.append(createTextElement(document, "h3", heading, "opsheet-logo-name"));
  if (part.head) {
    const size = `${formatMm1(logo.widthMm)} \u00d7 ${formatMm1(logo.heightMm)} mm` +
      (logo.rotationDeg !== 0 ? `, rotated ${formatMm1(logo.rotationDeg)}\u00b0` : "");
    panel.append(createTextElement(document, "p", size, "opsheet-size"));
    panel.append(createTextElement(document, "p", logo.side, "opsheet-side"));
    panel.append(createTextElement(document, "p", `Method: ${methodLabel(logo.method)}`, "opsheet-method"));
    if (logo.methodParams) {
      for (const key of Object.keys(logo.methodParams).sort()) {
        panel.append(createTextElement(document, "p", `${key}: ${logo.methodParams[key]!}`, "opsheet-param"));
      }
    }
    if (logo.colours && logo.colours.length > 0) {
      panel.append(createTextElement(document, "p", `Colours: ${logo.colours.join(", ")}`, "opsheet-colours"));
    }
    if (logo.dimensions.length === 0) {
      // Precise missing-measurement wording: when the logo already carries
      // physical width/height, only the anchor-to-edge placement measurements
      // are missing — never the dimensions themselves.
      const hasSize = Number.isFinite(logo.widthMm) && logo.widthMm > 0
        && Number.isFinite(logo.heightMm) && logo.heightMm > 0;
      panel.append(createTextElement(
        document,
        "p",
        hasSize
          ? "Placement measurements not set \u2014 setup needed."
          : "Dimensions not set \u2014 setup needed.",
        "opsheet-unfinished",
      ));
    }
  }
  if (part.dimsTo > part.dimsFrom) {
    const list = createElement(document, "ul", "opsheet-dims");
    for (let dimensionIndex = part.dimsFrom; dimensionIndex < part.dimsTo; dimensionIndex += 1) {
      const dimension = logo.dimensions[dimensionIndex]!;
      const item = createElement(document, "li");
      item.append(createTextElement(
        document,
        "span",
        `${refStart + dimensionIndex} \u2014 ${dimension.valueMm1} mm \u2014 ${dimension.fromAnchor}, ${shortEdge(dimension.toEdge)}`,
        "opsheet-dim-value",
      ));
      list.append(item);
    }
    panel.append(list);
  }
  if (isLastPart) {
    for (const reason of new Set(logo.unfinished)) {
      if (logo.dimensions.length === 0 && reason.includes('no anchor bindings supplied')) continue;
      panel.append(createTextElement(document, "p", reason, "opsheet-unfinished"));
    }
    for (const note of photoNotes) {
      panel.append(createTextElement(document, "p", note, "opsheet-photo-note"));
    }
  }
  return panel;
}

/** One concise business status line, only when it changes an operator
 *  decision (unfinished/draft work). A complete sheet carries no badge. */
function sheetUnfinishedCount(sheet: OperationSheetView["sheets"][number]): number {
  let count = sheet.logos.length === 0 ? 1 : 0;
  for (const logo of sheet.logos) count += logo.unfinished.length;
  return count;
}

function renderSheetPages(
  document: Document,
  view: OperationSheetView,
  sheetIndex: number,
  lookup: OperationSheetAssetLookup | undefined,
  brand: OperationSheetBrand | undefined,
): HTMLElement[] {
  const sheet = view.sheets[sheetIndex]!;
  const perLogo: string[][] = sheet.logos.map(() => []);
  // Sheet-wide dimension references in draw order: logo 1 owns 1..N, logo 2
  // continues \u2014 gutter labels and panel lines share this numbering on every
  // page, so repeated proofs and continuations never restart it.
  const refStarts: number[] = [];
  let nextRef = 1;
  for (const logo of sheet.logos) {
    refStarts.push(nextRef);
    nextRef += logo.dimensions.length;
  }

  // Card thumbnails resolve through the same caller-evaluated overlay as
  // the photo composites (artworks index-aligned with the logos), so a card
  // never shows art its proof does not stand behind.
  const overlayForSides = lookup?.getSheetOverlay?.(sheetIndex);
  const thumbs = sheet.logos.map((logo, logoIndex) =>
    resolveCardThumb(lookup, overlayForSides, logoIndex, logoHeading(logo)));
  // Thumbnail honesty without echo: the photo-overlay path already leaves
  // an explicit per-logo note about the same missing/undecodable artwork on
  // mapped sides \u2014 a card never repeats it, and an unmapped side still gets
  // exactly one concise note. Figure re-renders (repeated proofs) may push
  // the same strings twice; panels dedupe them below.
  const thumbNoteFor = (logoIndex: number): string | null => {
    const resolved = thumbs[logoIndex]!;
    if (resolved.thumb !== null || resolved.note === null) return null;
    if ((perLogo[logoIndex] ?? []).some((note) => note.includes("rtwork"))) return null;
    return resolved.note;
  };
  // One shared content-aware plan: the announced page count and the
  // rendered pages always agree (see planSheetPages). Relevance comes from
  // the same focused-print rule below, so each page budgets exactly the
  // proofs it renders.
  const planRelevance = relevanceForSheet(sheet, sheetIndex, lookup);
  const plan = planSheetPages(sheet, planRelevance, view.job);

  // Focused print: a side prints only when the overlay maps it AND at
  // least one artwork entry carries that mapping's region (i.e. the side
  // hosts logos/dimensions). Unrelated reference views are omitted from
  // print entirely \u2014 retained internally in the view model. Zero printable
  // sides yield exactly one concise honest note, never guessed overlays.
  const printableSides: number[] = printableSideIndices(sheet, overlayForSides);

  // Anchor letter codes are assigned per sheet in first-appearance order
  // across all its rendered sides, so one anchor keeps one code on every
  // page that repeats its proof. Occurrence counts figure renders so
  // repeated proofs never duplicate element ids.
  const anchorCodes = new Map<string, string>();
  const markerSeed = { next: 0 };
  let occurrence = 0;

  // Proof relevance: a side backs the page only when at least one of the
  // page's card parts binds it (the planner's own binding, so budgeted and
  // rendered proofs always agree). Every card keeps usable matching visual
  // evidence on its own page; cards with no bound artwork ride along on
  // honest text notes alone (nothing exists to repeat for them).
  const relevantSides = (parts: readonly SheetPagePart[]): number[] => {
    const wanted = new Set<number>();
    for (const part of parts) {
      if (part.kind !== "card") continue;
      const side = planRelevance.sideOfLogo(part.logo);
      if (side !== undefined) wanted.add(side);
    }
    return printableSides.filter((sideIndex) => wanted.has(sideIndex));
  };

  // Last part of a card sheet-wide: unfinished reasons and photo notes ride
  // it alone, so split cards state them exactly once. A part whose slice
  // reaches the card's final dimension is the last one on whatever page
  // renders it.

  const renderCards = (cards: HTMLElement, parts: readonly SheetPagePart[]): void => {
    parts.forEach((part) => {
      if (part.kind !== "card") return;
      const logoIndex = part.logo;
      const logo = sheet.logos[logoIndex]!;
      cards.append(renderCardPart(
        document,
        logo,
        [...new Set(perLogo[logoIndex] ?? [])],
        refStarts[logoIndex] ?? 1,
        part.head ? thumbs[logoIndex]!.thumb : null,
        part.head ? thumbNoteFor(logoIndex) : null,
        part,
        part.dimsTo === logo.dimensions.length,
      ));
    });
  };

  // Department-authored operational instructions only (`sheet.instructions`
  // carries department text exclusively; customer notes live in
  // `sheet.sourceNotes` and are never printed). Slices carry clear
  // identity: the section heading on the first slice, "(continued)" after.
  const renderInstructions = (page: HTMLElement, parts: readonly SheetPagePart[]): void => {
    const slices: string[] = [];
    let continued = false;
    for (const part of parts) {
      if (part.kind !== "instructions") continue;
      if (part.continued) continued = true;
      for (let p = part.parasFrom; p < part.parasTo; p += 1) slices.push(sheet.instructions[p]!);
    }
    if (slices.length === 0) return;
    const footer = createElement(document, "footer", "opsheet-instructions");
    footer.append(createTextElement(
      document,
      "h2",
      continued ? "Operational instructions (continued)" : "Operational instructions",
    ));
    for (const line of slices) footer.append(createTextElement(document, "p", line));
    page.append(footer);
  };

  // One page: the proofs relevant to its card parts (never orphaned, never
  // repeated without need), its card parts exactly once each, the filtered
  // legend and trial context for the proofs shown, its instruction slices
  // with clear identity, and the red band.
  const renderPlanPage = (
    parts: readonly SheetPagePart[],
    continued: boolean,
  ): HTMLElement => {
    const page = createElement(document, "section", "opsheet");
    page.append(renderSheetHeader(document, view, sheetIndex, brand, continued));

    if (!continued) {
      const unfinished = sheetUnfinishedCount(sheet);
      if (unfinished > 0) {
        page.append(createTextElement(
          document,
          "p",
          sheet.logos.length === 0
            ? "Draft \u2014 setup needed before production: no logos configured on this sheet."
            : `Draft \u2014 setup needed before production (${unfinished} unset item${unfinished === 1 ? "" : "s"}).`,
          "opsheet-status",
        ));
      }
    }

    const body = createElement(document, "div", "opsheet-body");
    // A logo-less sheet stages every printable proof; otherwise each page
    // stages exactly the proofs its card parts bind.
    // An operator may deliberately choose two views of the same placement.
    // A single logo-to-proof lookup must not silently discard the second view.
    const sides = sheet.logos.length === 0 ? printableSides : [...new Set([
      ...relevantSides(parts), ...printableSides.filter((index) => sheet.sides[index]?.kind === 'model'),
    ])].sort((a, b) => a - b);
    // Model views replace the photo demand: a sheet backed by model views
    // never asks for uploaded photos. Image-only products (no model views)
    // keep the established photo wording below.
    const photoSideCount = sheet.sides.filter((entry) => entry.kind !== "model").length;
    const hasModelSides = sheet.sides.some((entry) => entry.kind === "model");
    if (!continued) {
      if (sheet.sides.length === 0) {
        body.append(createTextElement(
          document,
          "p",
          "No product photo supplied for this sheet \u2014 setup needed. Dimensions below are the source of truth.",
          "opsheet-empty",
        ));
      } else if (printableSides.length === 0 && !hasModelSides) {
        body.append(createTextElement(
          document,
          "p",
          `${photoSideCount} supplied photo(s) not shown \u2014 no mapped logos on these sides; dimensions below are the source of truth.`,
          "opsheet-empty",
        ));
      }
    }
    const legendSink: Array<{ code: string; name: string }> = [];
    let renderedProofs = 0;
    let renderedMappedPhotos = 0;
    const cardParts = parts.filter((part) => part.kind === "card");
    // Proof scoping collects the page's card dim slices (a repeated proof
    // shows only its page's cards' dimensions, never another page's).
    const sliceOf = new Map<number, { dimsFrom: number; dimsTo: number }>();
    for (const part of parts) {
      if (part.kind !== "card") continue;
      const prev = sliceOf.get(part.logo);
      if (prev === undefined) sliceOf.set(part.logo, { dimsFrom: part.dimsFrom, dimsTo: part.dimsTo });
      else {
        prev.dimsFrom = Math.min(prev.dimsFrom, part.dimsFrom);
        prev.dimsTo = Math.max(prev.dimsTo, part.dimsTo);
      }
    }
    if (sides.length > 0) {
      const photos = createElement(document, "div", "opsheet-photos");
      // A repeated proof is scoped to its page's cards (null only for a
      // logo-less sheet staging every proof): each page stays a
      // self-contained proof-plus-cards group with no orphan diagrams and
      // no other page's dimensions.
      const logoFilter = sheet.logos.length === 0 ? null : sliceOf;
      for (const sideIndex of sides) {
        photos.append(renderSideFigure(
          document,
          view,
          sheetIndex,
          sideIndex,
          lookup,
          perLogo,
          anchorCodes,
          markerSeed,
          refStarts,
          occurrence,
          legendSink,
          logoFilter,
        ));
        occurrence += 1;
        renderedProofs += 1;
        if (sheet.sides[sideIndex]?.kind !== "model") renderedMappedPhotos += 1;
      }
      // Proof stage + card rail: garment proofs dominate left, light gray
      // logo cards ride the right rail. The views modifier follows the
      // proofs actually staged on THIS page \u2014 1: large proof + rail; 2:
      // two proofs in the left stage + rail; 3+: proofs grid + cards grid.
      // No fixed empty slots; two logos on one view share its single proof.
      const stage = createElement(document, "div", "opsheet-stage");
      addClass(
        stage,
        renderedProofs >= 3 ? "opsheet-views-3plus" : `opsheet-views-${Math.max(renderedProofs, 1)}`,
      );
      stage.append(photos);
      if (cardParts.length > 0) {
        const cards = createElement(document, "div", "opsheet-panels");
        addClass(cards, "opsheet-cards");
        renderCards(cards, parts);
        stage.append(cards);
      }
      body.append(stage);
    } else if (cardParts.length > 0) {
      // No proofs exist for these cards: the cards still ride a proof-less
      // stage so the rail styling (gray cards, red accents, thumbnails)
      // stays identical, with honest per-card notes instead of diagrams.
      const stage = createElement(document, "div", "opsheet-stage");
      addClass(stage, "opsheet-views-1");
      const cards = createElement(document, "div", "opsheet-panels");
      addClass(cards, "opsheet-cards");
      renderCards(cards, parts);
      stage.append(cards);
      body.append(stage);
    }

    if (sheet.logos.length === 0) {
      body.append(createTextElement(
        document,
        "p",
        "No logos configured on this sheet \u2014 0 logos, nothing to place, measure, or produce.",
        "opsheet-empty",
      ));
    }
    // Anchor legend filtered to the proofs on this page, in
    // first-appearance order; full anchor names stay verbatim.
    if (legendSink.length > 0) {
      const seen = new Set<string>();
      const entries: string[] = [];
      for (const entry of legendSink) {
        if (!seen.has(entry.code)) {
          seen.add(entry.code);
          entries.push(`${entry.code} \u2014 ${entry.name}`);
        }
      }
      body.append(createTextElement(document, "p", entries.join("; "), "opsheet-anchor-key"));
    }
    // Trial disclaimer travels with mapped photo proofs: every page that
    // renders a mapped photo states the trial plainly; model-view pages
    // render committed-revision captures (not trials) and say nothing here.
    if (renderedMappedPhotos > 0) {
      body.append(createTextElement(
        document,
        "p",
        "Mapped photos are visual trial overlays, not production approval.",
        "opsheet-trial-note",
      ));
    }
    page.append(body);

    renderInstructions(page, parts);
    appendFooterBand(page, document);
    return page;
  };

  const pages: HTMLElement[] = [];
  plan.pages.forEach((parts, pageIndex) => {
    pages.push(renderPlanPage(parts, pageIndex > 0));
  });
  return pages;
}

/**
 * Substantial station-red footer band closing every printed page, so each
 * page \u2014 proofs or continuation \u2014 carries the FlexiTog identity down to
 * its edge. Decorative only: hidden from assistive text.
 */
function appendFooterBand(page: HTMLElement, document: Document): void {
  const band = createElement(document, "div", "opsheet-footer-band");
  band.setAttribute("aria-hidden", "true");
  page.append(band);
}

function renderEmptyHeader(
  document: Document,
  view: OperationSheetView,
  brand: OperationSheetBrand | undefined,
): HTMLElement {
  const header = createElement(document, "header", "opsheet-header");
  const markUrl = safeDataUrl(brand?.markDataUrl);
  if (markUrl) {
    const mark = createElement(document, "img", "opsheet-mark");
    mark.setAttribute("src", markUrl);
    mark.setAttribute("alt", "FlexiTog");
    header.append(mark);
  } else {
    header.append(createTextElement(document, "span", "FlexiTog", "opsheet-brand-wordmark"));
  }
  const titles = createElement(document, "div", "opsheet-titles");
  const job = view.job;
  if (job.customer) titles.append(createTextElement(document, "p", `Customer: ${job.customer}`, "opsheet-job-line"));
  if (job.reference) titles.append(createTextElement(document, "p", `Reference: ${job.reference}`, "opsheet-job-line"));
  if (job.article) titles.append(createTextElement(document, "p", `Article: ${job.article}`, "opsheet-job-line"));
  header.append(titles);
  return header;
}

/**
 * Render the whole operation-sheet view: an output-level summary when more
 * than one sheet is present (so no product/variant is silently lost), then
 * one `.opsheet` page per sheet plus continuation pages only on true
 * overflow. Never clips, truncates silently, shrinks text unreadably, or
 * overlaps.
 */
export function renderOperationSheet(
  view: OperationSheetView,
  document: Document,
  assets?: OperationSheetAssetLookup | undefined,
  brand?: OperationSheetBrand | undefined,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const wrapper = createElement(document, "div", "opsheet-set");

  if (!isSheetView(view)) {
    const received = typeof view === "object" && view !== null
      ? String((view as Record<string, unknown>)["version"])
      : "none";
    wrapper.append(createTextElement(
      document,
      "p",
      `Unsupported operation sheet version \u201c${received}\u201d \u2014 expected \u201c${SHEET_VIEW_VERSION}\u201d; nothing was rendered rather than guessing.`,
      "opsheet-version-error",
    ));
    fragment.append(wrapper);
    return fragment;
  }

  if (view.sheets.length === 0) {
    const page = createElement(document, "section", "opsheet");
    addClass(page, "opsheet-last");
    page.append(renderEmptyHeader(document, view, brand));
    page.append(createTextElement(document, "p", "No configurations in this job \u2014 nothing to produce.", "opsheet-empty"));
    appendFooterBand(page, document);
    wrapper.append(page);
    fragment.append(wrapper);
    return fragment;
  }

  if (view.sheets.length > 1) {
    const summary = createElement(document, "div", "opsheet-set-summary");
    summary.append(createTextElement(document, "p", operationSheetSummary(view), "opsheet-set-summary-title"));
    const list = createElement(document, "ol");
    view.sheets.forEach((sheet, sheetIndex) => {
      list.append(createTextElement(
        document,
        "li",
        `${sheetTitle(sheet)} \u2014 ${sheet.logos.length} logo${sheet.logos.length === 1 ? "" : "s"} (sheet ${sheetIndex + 1})`,
      ));
    });
    summary.append(list);
    wrapper.append(summary);
  }

  let lastPage: HTMLElement | null = null;
  view.sheets.forEach((_, sheetIndex) => {
    for (const page of renderSheetPages(document, view, sheetIndex, assets, brand)) {
      wrapper.append(page);
      lastPage = page;
    }
  });
  if (lastPage) addClass(lastPage, "opsheet-last");

  fragment.append(wrapper);
  return fragment;
}

/**
 * Print + screen styles for the one-sheet output. Exactly one
 * `@page { size: A4 landscape; }` rule; every `.opsheet` page breaks to a
 * new printed page. All text stays at or above 9pt in print; no network
 * resources anywhere. FlexiTog identity: red mark + red header rule, gray
 * card rail with a small station-red (`#d20a2e`) accent per card, actual
 * logo thumbnails preserved with `object-fit: contain`, and a station-red
 * footer band closing every page (all print-exact).
 */
export function operationSheetStyles(): string {
  return `
    .opsheet-set { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 10.5pt; line-height: 1.4; color: #17252f; background: #fff; overflow-wrap: anywhere; }
    .opsheet-set-summary { border: 1pt solid #9fb0bc; border-radius: 4pt; padding: 6px 10px; margin: 0 0 10px; break-inside: avoid; }
    .opsheet-set-summary-title { font-weight: 700; margin: 0 0 4px; }
    .opsheet-set-summary ol { margin: 0; padding-left: 1.4em; font-size: 10pt; }
    .opsheet { border: 1pt solid #9fb0bc; border-radius: 4pt; padding: 5mm; margin: 0 0 8px; break-after: page; }
    .opsheet-last { break-after: auto; }
    .opsheet-header { display: flex; gap: 10px; align-items: center; border-bottom: 2.5pt solid #d20a2e; padding-bottom: 3px; margin-bottom: 4px; }
    /* Brand mark viewport (brand artwork only, never customer images): the
       bundled 270x270 mark carries its red wordmark in the middle ~38% band
       with blank margins above/below, so the box crops to that band with
       object-fit:cover at a fixed 45x17mm — visible lettering reads ~45mm
       wide like the reference, uniform scale preserved, source bytes kept
       verbatim. Thumbnails/photos elsewhere stay object-fit:contain. */
    .opsheet-mark { width: 45mm; height: 17mm; object-fit: cover; object-position: center; flex: none; }
    .opsheet-brand-wordmark { font-weight: 800; font-size: 15pt; letter-spacing: 0.02em; color: #d20a2e; flex: none; }
    .opsheet-titles { min-width: 0; }
    .opsheet-title { font-size: 13pt; margin: 0; line-height: 1.2; }
    .opsheet-job-line { margin: 1px 0 0; font-size: 9pt; color: #33424d; }
    .opsheet-status { font-weight: 700; font-size: 10pt; background: #fff8e1; border: 0.75pt solid #d9a92b; border-radius: 3pt; padding: 3px 6px; margin: 0 0 6px; }
    .opsheet-body { display: block; }
    .opsheet-stage { display: grid; gap: 4px; }
    .opsheet-stage.opsheet-views-1 { grid-template-columns: 8fr 5fr; }
    .opsheet-stage.opsheet-views-2 { grid-template-columns: 8fr 5fr; }
    .opsheet-stage.opsheet-views-3plus { grid-template-columns: minmax(0, 1fr); }
    .opsheet-stage.opsheet-views-1 .opsheet-photos { grid-template-columns: minmax(0, 1fr); }
    .opsheet-stage.opsheet-views-2 .opsheet-photos { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .opsheet-photos { display: grid; grid-template-columns: repeat(auto-fit, minmax(80mm, 1fr)); gap: 5px; min-width: 0; }
    @media (max-width: 600px) { .opsheet-photos { grid-template-columns: 1fr; } .opsheet-panels { grid-template-columns: 1fr; } .opsheet-stage.opsheet-views-1, .opsheet-stage.opsheet-views-2 { grid-template-columns: 1fr; } }
    .opsheet-photo { margin: 0; border: 0.75pt solid #c3ccd3; border-radius: 3pt; padding: 2px; break-inside: avoid; min-width: 0; }
    .opsheet-photo-svg { display: block; width: 100%; height: auto; max-height: 84mm; background: #fff; }
    .opsheet-stage.opsheet-views-1 .opsheet-photo-svg { max-height: 100mm; }
    .opsheet-stage.opsheet-views-1 .opsheet-photo-img { max-height: 100mm; }
    .opsheet-logo { position:relative; }
    .opsheet-logo-number { position:absolute;right:5px;top:5px;min-width:18px;height:18px;border:1px solid #155b7d;border-radius:50%;text-align:center;color:#155b7d;background:#fff;font-size:10pt;font-weight:700; }
    .opsheet-logo-name { padding-right:22px; }
    .opsheet-model-photo { border:0; }
    .opsheet-photo-img { display: block; width: 100%; height: auto; max-height: 84mm; object-fit: contain; background: #fff; }
    .opsheet-artwork-overlay { pointer-events: none; }
    .opsheet-arrow { stroke: #111; fill: none; }
    .opsheet-arrow-extension { stroke: #111; stroke-dasharray: 4 3; fill: none; }
    .opsheet-witness { stroke: #111; fill: none; }
    .opsheet-dim-label { fill: #111; font-weight: 700; }
    .opsheet-anchor-marker circle { fill: #fff; stroke: #111; stroke-width: 1.5; }
    .opsheet-anchor-marker text { fill: #111; font-weight: 700; }
    .opsheet-caption { font-size: 9pt; color: #4c5b66; margin: 2px 0 0; overflow-wrap: anywhere; }
    .opsheet-anchor-key { font-size: 9pt; color: #33424d; margin: 4px 0 0; break-inside: avoid; }
    .opsheet-panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(62mm, 1fr)); gap: 5px; margin-top: 4px; line-height: 1.3; }
    .opsheet-cards { display: grid; gap: 4px; margin-top: 0;align-self:start; }
    .opsheet-stage.opsheet-views-1 .opsheet-cards, .opsheet-stage.opsheet-views-2 .opsheet-cards { grid-template-columns: minmax(0, 1fr); }
    .opsheet-stage.opsheet-views-3plus .opsheet-cards { grid-template-columns: repeat(auto-fit, minmax(72mm, 1fr)); }
    .opsheet-logo { background: #eef1f3; border: 0.75pt solid #c3ccd3; border-radius: 3pt; padding: 3px 5px 4px; break-inside: avoid; min-width: 0; }
    .opsheet-logo::before { content: ""; display: block; width: 20mm; height: 2mm; background: #d20a2e; border-radius: 1mm; margin-bottom: 2px; }
    .opsheet-logo::after { content: ""; display: block; clear: both; }
    img.opsheet-card-thumb { float: left; width: 26mm; height: 20mm; object-fit: contain; background: #fff; border: 0.5pt solid #c3ccd3; border-radius: 2pt; margin: 1px 4px 2px 0; }
    .opsheet-stage .opsheet-cards .opsheet-logo { max-width: 110mm; }
    .opsheet-logo-name { font-size: 11pt; margin: 0; }
    .opsheet-size { font-weight: 700; font-size: 10.5pt; margin: 3px 0; font-variant-numeric: tabular-nums; }
    .opsheet-side, .opsheet-method, .opsheet-param, .opsheet-colours { font-size: 9.5pt; margin: 2px 0; }
    .opsheet-dims { list-style: none; padding: 0; margin: 3px 0; font-variant-numeric: tabular-nums; }
    .opsheet-dims li { margin: 1px 0; font-size: 9pt; }
    .opsheet-dim-value { font-weight: 700; }
    .opsheet-unfinished { font-size: 9.5pt; color: #6d4c00; background: #fff8e1; border: 0.5pt solid #d9a92b; border-radius: 3pt; padding: 3px 6px; margin: 4px 0; overflow-wrap: anywhere; }
    .opsheet-photo-note, .opsheet-placeholder, .opsheet-empty { font-size: 9pt; color: #5d4037; background: #fff8e1; border: 0.5pt solid #d9a92b; border-radius: 3pt; padding: 4px 6px; overflow-wrap: anywhere; margin: 4px 0; }
    .opsheet-empty { font-size: 10pt; break-inside: avoid; }
    .opsheet-version-error { font-size: 10pt; color: #6d1a00; background: #fdecea; border: 1pt solid #c62828; border-radius: 4pt; padding: 8px 10px; }
    .opsheet-instructions { margin-top: 4px; border-top: 1pt solid #0f2a3d; padding-top: 4px; break-inside: avoid; }
    .opsheet-instructions h2 { font-size: 10.5pt; margin: 0 0 2px; }
    .opsheet-instructions p { font-size: 9pt; margin: 2px 0; line-height: 1.3; white-space: pre-wrap; overflow-wrap: anywhere; }
    .opsheet-trial-note { font-size: 9pt; color: #4c5b66; font-style: italic; margin: 4px 0 0; break-inside: avoid; }
    .opsheet-footer-band { height: 6mm; background: #d20a2e; border-radius: 2pt; margin-top: 4px; break-inside: avoid; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    .opsheet-logo, .opsheet-logo::before { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    .opsheet-deprecated-notice { font-size: 10pt; color: #5d4037; background: #fff8e1; border: 1pt solid #d9a92b; border-radius: 4pt; padding: 8px 10px; margin: 8px 0; }
    @page { size: A4 landscape; margin: 10mm 10mm 12mm; }
    @media print {
      body, .opsheet-set { background: transparent; }
      /* The set summary is screen-only: every printed page already repeats
         its product/variant context in its own header, and the summary div
         emitted outside the planned pages can fragment the first print page
         (observed: 3 sheets → 4 PDF pages with a blank p2). Screen keeps it
         so no product/variant is silently lost before printing. */
      .opsheet-set-summary { display: none; }
      .opsheet { border: none; border-radius: 0; padding: 0; margin: 0; min-height: 186mm; display: flex; flex-direction: column; }
      .opsheet-footer-band { margin-top: auto; }
      .opsheet-instructions p { orphans: 3; widows: 3; }
    }
  `;
}

/**
 * @deprecated The 7-page appendix renderer is retired. This shim keeps the
 * previous export name resolving (existing callers still bundle) but renders
 * an explicit migration notice instead of production content: rebuild the
 * preview from an `OperationSheetView` with `renderOperationSheet`.
 */
export function renderOperationDocument(
  _doc: OperationDocument,
  document: Document,
  _assets?: OperationDocumentAssetLookup,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(createTextElement(
    document,
    "p",
    "The multi-page operation document preview was retired. Rebuild this preview from an OperationSheetView with renderOperationSheet (one branded A4-landscape sheet per product/variant).",
    "opsheet-deprecated-notice",
  ));
  return fragment;
}

/**
 * @deprecated The 7-page appendix styles are retired. Returns the one-sheet
 * styles so deprecated preview surfaces still print sanely.
 */
export function operationDocumentStyles(_identity?: OperationIdentity): string {
  return operationSheetStyles();
}
