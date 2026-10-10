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
were changed, no discovered methods executed, and no artwork downloaded.

Discovery used typed search, read, count and parent-linked evidence operations.
Each response has a local capture containing its timestamp, request/projection,
scope, broker revision and result. The current sealed metadata is preserved in
`private/odoo-discovery-context.json`. The detailed report with model/ID chains
and capture citations is `private/odoo-discovery-report.md`.

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
| Artwork source | Order attachment relationship and parent-linked metadata | Artwork/proof files were listed, not examined. |
| Operator instructions | Routing note and worksheet type | A sampled note refers to a document folder; worksheet content is unverified. |
| Physical dimensions/calibration | Unresolved | No verified production measurements in this sample. |

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

Before Phase 2 schema finalization:

- Inspect operator work orders and worksheets. `stock.move.workorder_id` points
  to confirmed work orders, but `mrp.workorder` is outside the current catalog.
  Any addition requires a separate human-reviewed broker setup; no bypass was
  attempted.
- Examine representative artwork/proof documents after download authorization,
  and confirm the measurements and coordinate conventions production uses.
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
