# Operation sheet from the internal Builder

Target requirement added on 2026-10-10. Updated 2026-10-15: a bounded
pending-review operation-document preview is implemented in the internal
customer-return reviewer. Updated 2026-10-20 (user-authoritative,
supersedes the multi-page/appendix contract below): the default production
handoff is ONE branded operation sheet (A4 landscape) plus a minimal
operator JSON export. Stale paragraphs insisting on printing all technical
data, every-page IDs, appendices or arbitrary page counts are marked
accordingly; the 2026-10-20 contract in "Purpose and source", "Content" and
"Acceptance criteria" is normative.

The provisional internal Builder now previews and prints these sheets
locally. A direct production PDF renderer and Odoo attachment integration remain pending.

## Purpose and source

Generate one self-contained branded operation sheet for the ticket and BoM
from a selected canonical project revision. Follow the useful discovered
proof layout: prominent product views with applied logos and compact
specification panels. Enrich those views with the measurements and
department instructions the logo department authors.

The sheet carries ONLY what the operator needs to perform the operation:
human job/customer/article identity (only where supplied), relevant
product/variant, logo business identity (supplied name/code or positional
fallback — never generated internal ids), side/position, method, logo size
(width×height in mm), selected anchor-to-edge measurements in millimetres,
department operational instructions, and supplied method parameters.
Customer notes stay labelled source context in the editor and never print
as operational instructions. Missing values remain visibly unfinished
("setup needed") — never fabricated. Changes are made to the project and
sheets regenerated. Customer reference originals remain in ignored private
storage; implementation fixtures use synthetic artwork and garments.

The project is the editable source. The sheet, its previews and the
minimal operator JSON export derive from the same configuration.

## Content

| Section | Information |
| --- | --- |
| Header | FlexiTog mark, human customer / reference / article, product/variant titles |
| Product views | Selected local 3D-model views or actual garment photos, with applied original artwork and clean dimension arrows from the same pure mm calculations as the panels; unmapped photos are labelled reference-only |
| Logo panels | Business logo name/code, actual width×height in mm, readable side/position, method, optional supplied colour/thread refs and method parameters |
| Instructions | Logo-department operational instructions only (staff-authored) |
| Status | One concise business draft/status indicator, only when it changes an operator decision |

Number placements consistently across views and panels. Use the actual
selected artwork revision in the render. A reference image is not an
additional placement. Represent zero placements explicitly instead of
reusing a previous logo.

## Page composition

- One branded `.opsheet` page per sheet at A4 landscape; continuation pages
  only when a sheet's logo panels truly overflow (4 first-page, 6 later).
  Never clip, truncate silently, shrink text unreadably, or overlap.
- For multi-sheet jobs print a selection summary first so no
  product/variant is silently lost.
- The ordinary one-product/two-logo front+back job prints EXACTLY one A4
  landscape page at default 100% with legible text (≥9pt print).
- Their measurements come from physical placement data (selected
  anchor-to-edge geometry in authoritative mm), not pixels or apparent
  perspective. If mapping, anchors or dimensions are unresolved, the sheet
  says setup is needed and shows the draft badge instead of guessing.
- Never print digests, hashes, schema/calibration/frame/project/config
  IDs, timestamps, history, appendices, audit pages, duplicate unbranded
  photos, repeated artwork originals, or generic disclaimer lists.

The document must provide enough physical reference information to
reproduce a placement. Front/back photos plus the selected anchor-to-edge
distances and logo sizes do; a bare photo or an unmeasured diagram does not.

## Revision and handoff

Allow pending-review sheets for tickets and approved sheets for production.
Show customer confirmation and departmental approval separately in the
review UI (never on the operator sheet beyond the concise status badge);
staff wording must never forge customer approval or silently rewrite
canonical customer instructions.

The same selected revision supplies the ticket and BoM so their
instructions match. Earlier revisions remain historical, with the current
approved revision clearly identified. The Builder previews and downloads
the sheet locally plus a minimal operator JSON export carrying the same
business data and no technical envelope; the legacy technical candidate
export remains an explicitly advanced diagnostic action, never the default
handoff. Manual attachment is the initial handoff. Automatic Odoo
attachment is a separate write integration requiring authorization,
outside current read-only discovery grants.

## Current bounded implementation (2026-10-15)

> Superseded as the default handoff by the 2026-10-20 one-sheet contract
> above. The canonical archive path (`buildCandidateExport` /
> `serializeExport`, identity digest, technical appendix) stays internal
> and compatible; only the operator-facing default changed. Preserved as
> provenance.

The internal customer-return reviewer previews a pending-review operation
document alongside the candidate JSON download:

- `src/core/operation-document/index.ts` builds a pure view model from the same
  `ResultCandidate` snapshot used for the JSON download. It preserves exact,
  unrounded mm dimensions, centre, rotation, frame axes/origin, calibration
  identity and artwork asset references.
- `src/ui/shared/operation-document/renderer.ts` renders the view model to DOM,
  escaping all text. It produces one section per configuration, including
  explicit zero-placement configurations, and a planar SVG positioning diagram
  per placement showing the safe polygon, exclusions and rotated logo footprint.
- `src/ui/customer-return-review/main.ts` integrates the preview and a
  "Print operation document (browser PDF)" button. Print CSS hides the reviewer
  chrome and shows only the document. Physical diagrams use a Y-up frame and
  the actual datum; dashed lines show the centre offsets. Long instructions
  retain line breaks and paginate; project/revision/pending status and page
  numbers repeat in print margin footers.
- The document always states `candidate-pending-review`, even after a local
  internal workflow approval. It separately shows any local customer
  confirmation and internal review evidence, clearly labelled as unauthenticated
  workflow data.
- Limitations are printed on the document: diagrams are illustrative/not to
  scale; only logo footprints are shown; product views, SKU, colour, thread and
  ticket data are absent; calibration and physical validation are unresolved.

Codex rendered and visually inspected all pages of synthetic A4 browser PDFs
(6-page normal and 9-page long-instruction cases), checking legibility,
clipping, diagram direction, pagination and repeated identity/status. The long
case preserves 85 project-instruction lines and 45 placement-note lines.
This is macOS Chromium development evidence; native print-dialog settings and
Windows Chrome/Edge still require delivery validation. See `offline-testing.md`.

## Acceptance criteria

- One branded sheet per product/variant with the FlexiTog mark, human
  job/customer/article identity only where supplied, and actual applied artwork.
- Logo panels show the business name/code (never generated ids), actual
  width×height mm, readable side/position, method and only supplied
  extras. Displayed dimensions equal the pure mm calculations.
- Selected anchor-to-edge dimensions with honest arrows/labels; missing
  anchors map unambiguously unfinished, never fabricated.
- Department instructions print verbatim; no customer note appears on the
  sheet unless staff explicitly entered it as operational text.
- No digest/hash/schema/calibration/frame/project/config IDs, timestamps,
  history, appendix or warning walls anywhere on the sheet or in the
  minimal operator JSON.
- Ordinary one-product/two-logo front+back job: exactly 1 A4 landscape
  page at default settings; no clipping/overlap; ≥9pt legible text.
- Overflow and 0-logo jobs preserve all operations without silent loss.
- Open independently without external images, fonts or network assets.
- Render and inspect every page for legibility, clipping and overlapping labels.
- Verify regenerated sheets against project changes with synthetic data; no live
  Odoo calls in automated tests.

## Package-asset preview extension — 2026-10-18

> Still valid as the artwork/photo plumbing the one-sheet renderer reuses
> (header-validated raster previews embedded as data URLs; reference views
> illustrative only). The "technical appendix keeps full precision" framing
> is superseded: the operator sheet shows 1-decimal display values from the
> same pure numbers and prints no appendix.

The Builder and standalone reviewer now supply package asset bytes to the
operation-document view model and renderer. Bounded PNG/JPEG/WebP artwork
previews and product reference images are embedded locally; SVG and other
unsupported artwork remain preserved originals with an explicit placeholder.
Header-valid images that fail native decoding also become an explicit
placeholder. Reference views are illustrative and never establish calibrated
artwork placement on a garment. The exact candidate revision, digest,
measurements, instructions and pending-review status remain authoritative.

Codex independently printed two synthetic A4 documents containing a product
reference and raster artwork: 7 normal pages and 9 pages with 85 instruction
lines. All 16 pages were rendered with Poppler and visually inspected for
legibility, clipping, diagrams and image placement. Extracted text confirmed
project/revision/status/page numbering on every page and all 85 instruction
lines. The browser used offline `file://`, with zero console/page errors and
HTTP(S) requests. This is macOS Chromium development evidence; native Windows
print dialogs, printer scaling and physical production accuracy remain untested.

## One-sheet operator contract — 2026-10-20

- `src/core/operation-document/*` builds the minimal `OperationSheetView`
  (`operation-sheet-view/1`): job/customer/article, per-sheet
  product/variant, per-logo business identity, sizes, selected
  anchor-to-edge dimensions, department instructions, supplied method
  params. No ids, digests, calibration dumps, history or byte arrays.
- `src/core/operation-measurements/*` computes selected edge-to-anchor
  distances in authoritative mm from the exact rotated footprint
  (`dx`/`dy`/shortest-to-edge, strict axis compatibility, nearest-corner
  honesty for extended arrows). Missing/stale scope stays explicitly
  unfinished. The `operation-draft/1` sidecar persists department
  authoring bound to source revision/digest with explicit stale refusal.
- `src/ui/shared/operation-document/*` renders branded A4-landscape
  `.opsheet` pages per sheet with the FlexiTog reference hierarchy (red
  mark + Customer/Reference/Article block; garment proofs dominating a
  left stage; light gray logo cards with real thumbnails + red accents on
  a right rail; red footer band): fixed-space exterior technical
  dimension lanes (photo + mapped artwork untouched inside a nested
  frame; parallel-offset dimension lines with arrowheads on both ends,
  witness lines back to the true mapped points, explicit coincident
  depiction for zero mm — never reshaped extents or invented spans),
  black gutter labels with unique sheet-wide refs, short A/B anchor
  markers at true points with a legend mapping codes to full names,
  code-alone headings, one concise dimension line per logo, side-only
  captions, a trial disclaimer per proof page, usable photos (no text
  over photo pixels except ≤2-char anchor codes; 9pt print minimum).
  Composition is adaptive: only mapped logo-hosting views print
  (front/back/left/right peers; co-located logos share one proof); each
  page stages exactly its cards' relevant proofs (cards exactly once,
  repeated proof/context allowed, never orphaned); content-aware
  pagination splits oversized cards/instructions with continued
  identity. `operationSheetPageCount(view, lookup)` shares one planner
  with the renderer — callers pass the same evaluated lookup they
  render with for the exact count (without it the counter stays a
  conservative upper bound).
  (`"format": "operation-export/1"`): `{job, products: [{product, variant,
  logos: [{code, side, method, widthMm, heightMm, rotationDeg,
  methodParams?, colours?, measurements: [{anchor, logoEdge,
  distanceMm}]}]}]}` — business data only, no ids, digests, paths,
  source notes, display duplicates, diagnostics or history. File name is
  `<safe-job-reference>-operator.json` (`operation-sheet-operator.json`
  fallback, never UUIDs). The raw candidate JSON stays available under
  "More tools" as `Save diagnostic data` (advanced only, never the
  default handoff). Operation drafts save as
  `<safe-job-reference>-r<revision>[-<config>]-operation-draft.json`
  (generic `operation-sheet` fallback; internal revision/digest binding
  unchanged).
- `src/ui/internal-builder/*` authors operational instructions, job
  fields, technique params, per-logo anchor/edge dimensions (1..N rows),
  visual anchors + safe-area setup on the product photo, draft save/reopen
  and prepared-master apply/save. `src/ui/customer-return-review/*`
  renders the honest read-only preview (setup-needed where unauthored).
- Verified: `npm run typecheck`, full unit suite, offline Playwright
  (bundled Chromium + real Chrome) including a 1-page A4 PDF assertion
  via Chromium `page.pdf`, desktop/narrow screenshots and print-media
  checks, all with zero console/page errors and zero HTTP(S) requests.
  Windows Chrome/Edge `file://` remains the untested delivery gate.

## Model-only jobs (2026-10-28)

A calibrated local GLB is sufficient for the operational document; photos are
optional. Review creates relevant front/back views with applied artwork. Use
Adjust view to rotate, pan, fit or zoom each view; add, remove and reorder views
as needed. Cameras and view order persist as versioned presentation metadata
in the editable project package, independently of physical mm and production
revision. Changing a model invalidates its saved views until adjusted.

In placements, name a reference point and pick it directly on the model, then
use Add measurement to bind an artwork edge to that reference. Physical
anchor/edge calculations supply both the document arrows and operator JSON.
Unbound references remain explicitly unfinished. Document capture excludes
editing handles and safe-area shading while retaining the actual artwork.
