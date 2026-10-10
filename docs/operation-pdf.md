# Operation PDF from the internal Builder

Target requirement added on 2026-10-10. This specifies the planned export;
the renderer, Builder and Odoo attachment integration are not implemented yet.

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
