# Operation PDF from the internal Builder

Target requirement added on 2026-10-10. Updated 2026-10-15: a bounded
pending-review operation-document preview is implemented in the internal
customer-return reviewer. It uses the same canonical `buildCandidateExport` /
`serializeExport` snapshot as the JSON download and is rendered to the browser
for user-initiated Print / Save as PDF. It is not a direct PDF download and is
not production-ready.

The provisional internal Builder now previews and prints these documents
locally. A direct production PDF renderer and Odoo attachment integration remain pending.

## Purpose and source

Generate a self-contained operation PDF for the ticket and BoM from a selected
canonical project revision. Follow the useful discovered proof layout: prominent
product views with logos and compact specification panels. Enrich those views
with the measurements, instructions and review information the tool creates.
Customer reference originals remain in ignored private storage; implementation
fixtures use synthetic artwork and garments.

The project is the editable source. PDF, previews and structured operational
output derive from the same configuration. Include all recorded operational
information, not raw mesh data or unrelated commercial metadata. Missing values
remain visibly unresolved. Changes are made to the project and PDFs regenerated.

## Content

| Section | Information |
| --- | --- |
| Document identity | Project/job reference, revision, available ticket/order/BoM references, generation details and review status |
| Product identity | Actual product/style, colour, SKU and selected variants; distinguish reference garments from configured products |
| Product views | Relevant front/back/side views showing every placement, with consistent placement numbers and a readable legend |
| Placement detail | Artwork preview and identity/version, method, known colours/thread references, region, width/height in mm, rotation and applicability |
| Positioning diagram | Named datum/landmarks, frame, placement reference point, mm offsets and recorded flat/surface measurement convention |
| Instructions | Recorded method settings, garment modifications, handling/application notes and customer/internal instructions |
| Variant differences | Shared placement rules, selected sizes and per-variant overrides; separate diagrams where physical positioning differs |
| Review record | Customer pre-approval of the exact configuration, Logo Station decision, outstanding issues and relevant revision history |

Number placements consistently across views, diagrams and tables. Use the actual
selected artwork revision in the render and specification panel. A reference
image is not an additional placement. Represent zero placements explicitly where
applicable instead of reusing a previous logo.

## Page composition

- Provide a project/review summary and group detail pages by configured product.
- Combine garment views and logo panels, following the discovered proof layouts.
- Add enlarged, dimensioned region diagrams for positioning. Their measurements
  come from physical placement data, not pixels or apparent perspective.
- Add pages for extra placements, variants or instructions instead of shrinking
  everything onto one sheet. Shared applicability tables can avoid identical pages.
- Put project/revision, review status and page numbers on every page. Label renders
  as illustrative; only claim scale when verified and printing requirements stated.

The document must provide enough physical reference information to reproduce a
placement. Left chest and a camera render alone do not establish precise offsets.
If calibration or positioning data is unresolved, a review PDF shows that gap.

## Revision and handoff

Allow pending-review PDFs for tickets and approved PDFs after Logo Station
approval. Show customer and internal approval separately. Relevant configuration
changes create a new revision and require the applicable review again.

The same selected revision supplies the ticket and BoM so their instructions
match. Earlier revisions remain historical, with the current approved revision
clearly identified. The Builder previews and downloads the PDF locally; manual
attachment is the initial handoff. Automatic Odoo attachment is a separate write
integration requiring authorization, outside current read-only discovery grants.

## Current bounded implementation (2026-10-15)

The internal customer-return reviewer now previews a pending-review operation
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

- Cover all configured products, variants and placements, with consistent numbers
  and applicability across diagrams and tables.
- Match dimensions, positions, rotation and frames to the selected project and
  structured output, without rounding ambiguity.
- Match artwork, method/colour panels and instructions to that revision.
- Show pre-approval, departmental review and outstanding issues legibly; pending
  documents must not present themselves as approved production instructions.
- Preserve variant overrides and factory garment modifications.
- Open independently without external images, fonts or network assets.
- Render and inspect every page for legibility, clipping and overlapping labels.
- Verify regenerated PDFs against project changes with synthetic data; no live
  Odoo calls in automated tests.

## Package-asset preview extension — 2026-10-18

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
