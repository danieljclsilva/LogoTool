# Odoo discovery — initial evidence gate

Investigation date: 2026-10-10. **Phase 1 is in progress; production schemas are
not ready to finalize.** This tracked document contains general findings only.
Customer identifiers, references, instructions, artwork filenames and raw
responses remain in ignored local files under `private/`.

## Evidence and sample boundaries

The human approved read-only discovery of the brief's references and their
related records, instructions and attachment metadata. The enabled broker
scope covers two companies; UK company records are not enabled. Archived and
companyless records can be visible under the sealed policy. No permissions
were changed and no discovered methods executed. The first pass examined
attachment metadata only; the later retry included three explicitly approved
local document downloads, described below.

Discovery used typed search, read, count and parent-linked evidence operations.
Each response has a local capture containing its timestamp, request/projection,
scope, broker revision and result. The current sealed metadata is preserved in
`private/odoo-discovery-context.json`. The detailed report with model/ID chains
and capture citations is `private/odoo-discovery-report.md`.
The retry supplement and document observations are preserved in
`private/odoo-discovery-retry-report.md` and `private/odoo-document-findings.json`.

The initial sample contains three supplied sales orders, two further orders
identified through manufacturing origins, and three inspected completed
manufacturing jobs. Product descriptions cover T-shirts, gilets and jackets;
this does not establish the category mix of Logo Station as a whole. Focused
sales-line, selected BoM and manufacturing/component queries were reconciled
against separate counts where documented in the private report. Counts apply
to their exact scope and date windows, not all historical records. One pacing
denial was retained and the request succeeded after backoff.

## Observed record chains

1. An order in one company is linked by a second company's order through
   `final_order_id` and `auto_purchase_order_id`. The orders contain the same
   eight finished size SKUs. The second order leads to eight manufacturing
   records. An inspected manufacturing job consumes a base garment and one
   stock logo component.
2. A finished jacket variant leads through its manufacturing record to a
   template BoM with unconditional chest/back logo components and conditional
   garment and optional logo components. Its inspected completed component
   moves record one base garment and two distinct logo components.
3. Another historical T-shirt job records two distinct logo components and a
   base garment in completed component moves. Its current linked BoM contains
   only one logo component and points to a different finished template from
   the archived produced variant. Current BoM content alone cannot reconstruct
   that job's component history.
4. Generic gilet and jacket templates have size and placement variants and a
   separate decoration attribute. Their sampled current/archived BoMs contain
   logo service charges. Such charges are service products used for costing;
   a service-charge quantity does not identify a physical artwork placement.

Completed moves establish recorded component quantities. They do not prove
the exact physical position, orientation, artwork dimensions or operator UI.

## Source-of-truth candidates

| Information | Observed source | Qualification |
|---|---|---|
| Finished SKU and size | `product.product`, template attribute values | Template references and variant SKUs are distinct. |
| Base garment | BoM lines and completed `stock.move` records | Respect variant conditions and historical changes. |
| Stock logo identity and quantity | Logo products, BoM lines, completed component moves | Do not equate all service lines with artwork. |
| Placement vocabulary | Placement attributes and logo type attributes | Chest/back/custom labels are not mm coordinates. |
| Decoration method | No-variant sale-line options, logo attributes, routing workcentre | Terminology differs between the two branding paths. |
| Customer/job linkage | Order references and intercompany relationship fields | Internal follow-up orders are not automatically reorders. |
| Artwork source | Order attachment relationship and parent-linked metadata | One artwork image and its linked proof were inspected on retry. |
| Operator instructions | Routing operation and field-backed worksheet PDF | A sampled worksheet contains template-based placement guidance and process settings. Actual operator screen remains unverified. |
| Logo size | Visible annotation in an attached proof | A size dimension is present; dimension conventions, height and physical positioning remain incomplete. |
| Physical positioning/calibration | Unresolved | The inspected documents do not establish a calibrated mm placement frame. |

Field semantics and permitted projections are preserved in the local metadata
capture. Server provenance does not establish whether a field is standard or
custom; addon/registry provenance remains unknown where not evidenced.

## Category and multiple-logo findings

The sampled internal categories use a Body hierarchy with A/B/C subdivisions.
These are not a verified taxonomy of garment shapes. Stock logo products can
sit under a category called Service while still having a stockable product
type. Classification must consider evidence beyond a category label.

Two of the three inspected completed jobs record two distinct logo components;
the other records one. This is a deliberately selected sample, not a prevalence
estimate. No case yet proves repeated use of the same design at multiple
physical locations. Conditional BoM lines must not all be counted as simultaneous
placements. Likewise, combined chest/back options alone do not prove actual
production in that configuration.

## Unresolved questions and exit criteria

## Broker retry and document review

After the user fixed the tool, sealed metadata exposed 45 models, including
`mrp.workorder`, under the same enabled company scope. Direct reads of the three
previously identified work orders succeeded. Their manufacturing, operation,
product and workcentre links and produced quantities match the sampled chains.
Production-ID queries reconciled three work orders and eight component moves
with separate counts, without the earlier component create-date restriction.

The catalog now distinguishes binary `attachment_evidence` from generic field
readability. Work-order worksheet listings were empty, but following an approved
`operation_id` to its routing operation exposed one worksheet PDF through
`field: worksheet`. Ordinary attachment listings had not exposed that file.
Four sampled product-template artwork fields returned no attachments; these
results do not prove the artwork is absent from other related records.

With explicit download approval, the worksheet, an order proof and an artwork
image were downloaded through the broker. Their byte hashes were verified
against the broker's hashes. Both one-page PDFs were rendered and visually
reviewed alongside text extraction; files, extracted text and detailed findings
remain under ignored `private/` paths.

Observed document findings:

- The worksheet combines a garment/placement illustration with process settings
  and instructions to orient a physical template at the collar, using size
  markings and visual adjustment. It does not provide numerical anchor offsets,
  a calibrated surface map or safe-area boundaries.
- The visible proof identifies front-side embroidery, a chest position, a logo
  size dimension and colour references. Its garment sketch explicitly describes
  proportions and colours as approximate. The picture cannot establish physical
  placement coordinates or calibration. The proof does not identify an exact
  article/SKU, so applicability to every line of its linked order is unconfirmed.
- PDF text extraction contains unused back-side template fields absent from the
  visible proof. These are not evidence of an additional logo, zero-sized artwork
  or an approved back-side placement.
- The proof requests reuse of the digital proof for future orders. This is
  documented reorder guidance, not evidence that a particular reorder occurred.

The retry preserved 15 additional record/evidence captures, bringing the local
capture set to 96. Download metadata and content hashes are retained separately.
Three initial destination-write refusals were resolved by creating the parent
directory through the broker workspace tool; original denial evidence remains
local. No credentials, documents or customer-specific dimensions were published.

## Remaining exit criteria

Before Phase 2 schema finalization:

- Confirm the operator-facing workflow and how the inspected worksheet is used
  in practice. Work-order access and one worksheet review are now complete;
  no operator screen or physical process was observed.
- Confirm the logo-size annotation convention, production measurements,
  physical template dimensions and coordinate conventions. Documents provide
  partial guidance but not a complete mm placement specification.
- Extend evidence to non-upper-body products, unusual placements, repeated
  designs and genuine reorders. No Plover-specific taxonomy is justified.
- Define a bounded Logo Station job population and denominator before claiming
  category frequency or multi-logo prevalence. No global aggregate was run.
- Resolve remaining ambiguous brief references and historical BoM/template
  differences. Empty exact searches are scoped observations, not proof of
  absence or record meaning.
- Establish safe/excluded placement areas, revision rules, mandatory operator
  fields, artwork ownership and which fields a future export may populate.

The private report maps all 25 questions from brief section 44 to findings or
explicit gaps. Missing evidence remains unknown rather than an invented default.

## Proposed development direction

Keep stock artwork components, costing/service items, decoration methods and
physical placements conceptually distinct. Preserve per-variant applicability
and historical evidence. The future placement model must support 0..N placements
in millimetres with explicit frames and calibration, independently of rendering.
These are design directions, not finalized product or production schemas.

The current implementation is offline developer evidence tooling with synthetic
tests. It does not yet deliver the customer configurator or an offline HTML
package. Subsequent milestones remain subject to the evidence gate above.
