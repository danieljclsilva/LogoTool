# cli-odoo readiness for Logo Station discovery

Assessment date: 2026-10-10.

## Decision

Use `cli-odoo` for the initial read-only discovery described in
`FlexiTog_Logo_Station_3D_Configurator.md`, especially sections 8–12 and 44.
The core RPC capabilities are sufficient. The default agent investigation
profile is a starting point, not assurance of complete Logo Station coverage.
Review model/field permissions and company scope before querying records.

No Odoo connection, authentication, metadata request, record query, attachment
download, or live test was performed for this assessment. No CLI source was
changed. Conclusions below come from the project brief and local source code;
they do not establish how FlexiTog actually uses Odoo.

The CLI belongs in internal discovery and, potentially, the internal Builder's
data acquisition. Customer packages must contain exported data and assets and
remain usable offline without the CLI, credentials, or an Odoo connection.
Writing configurator results back to Odoo would be a separate integration:
this CLI intentionally has no write path.

## Requirements and current coverage

| Discovery need | Current capability | Qualification |
|---|---|---|
| Identify models and technical fields | Human CLI `models`, `fields`, `schema`, `relations`; broker `meta`/`catalog` | Broker metadata is sealed, limited to captured models, and less detailed than live `fields_get`. |
| Resolve supplied references | Exact-reference searches with explicit projections | Preserve `04368`, `00303`, etc. as strings. Determine the record type before assigning meaning. |
| Trace customer, order, product and variant relationships | Search/read and relational metadata | Follow database IDs in separate queries; broker return fields cannot be dotted paths. |
| Trace finished garment, components and multiple logos | BoM, BoM-line, product and manufacturing models in investigation proposal | No one-logo restriction. Identify component roles from evidence rather than SKU guesses. |
| Inspect operations and operator instructions | Routing operations, workcentres, manufacturing records, stored custom text, linked evidence | `mrp.workorder` is absent from the default proposal; custom workflow models need explicit review. |
| Infer category/variant frequency | Counts, aggregates and paginated reads | Define the population, date interval and denominator. Broker aggregate results have a group limit and no offset. |
| Inspect artwork and placement documents | Parent-bound attachment listing/download and chatter/tracking | Broker download cap is 2 MiB; URL attachments are not fetched. |
| Produce auditable discovery report | Stable JSON results, broker workspace and local files | CLI does not automatically join chains or write a source-of-truth report. Investigation must preserve query provenance. |

## Concrete limitations

### 1. Work orders and custom models

`cmd/agentinvestigation.go` proposes `mrp.production`, `mrp.routing.workcenter`
and `mrp.workcenter`, but not `mrp.workorder`. Existing setup supports repeatable
`--include-model`; a human can request `mrp.workorder` without a code change if
live metadata confirms the required direct `company_id` relationship.
Additional requests are mandatory: unavailable or unenforceably scoped models
abort setup rather than being silently granted.

The default proposal also includes Helpdesk, sales, products, categories,
attributes, BoMs, stock and linked evidence. These are candidates for this
project, not proof that a particular Logo Station job uses those models.
The broker cannot enumerate arbitrary unknown custom models on demand; a human
must identify and approve additions.

### 2. Field coverage and reverse relationships

The investigation field filter admits stored scalar, many2one, many2many,
JSON and property fields. It excludes one2many, nonstored fields, business
binaries and secret-like names. Metadata can describe excluded fields while
their values remain unreadable.

Therefore an unreadable relation is not evidence that the business relation
does not exist. Prefer querying the child model by a confirmed readable inverse
many2one: for example, BoM lines by `bom_id` and sales lines by `order_id`.
Confirm names/types in the actual catalog first. If an essential computed
instruction or relation cannot be recovered this way, review an explicit manual
field policy rather than granting every computed field.

### 3. Bounded queries

The default broker requires a flat AND domain with an accepted positive-ID or
exact-reference anchor, or a supported date interval of at most 31 days, for
models that are not classified company-independent. Fuzzy searches and OR
reference searches alone do not meet this guard. Query the supplied references
individually and page in stable ID order.

`product_id`, `product_tmpl_id`, `bom_id`, `order_id` and several other relations
are accepted anchors. `production_id` is not currently an anchor. If work-order
tracing needs a domain containing only `production_id = <approved MO ID>`, a
small reviewed `mrp.workorder` anchor addition would be appropriate. Use an
available confirmed ID or bounded date route for initial inspection; do not
disable bounded queries across the profile as a shortcut.

### 4. Company scope

The broker currently requires at least two enabled companies and a default
among them (`internal/agent/policy/company.go`). The user must determine the
appropriate scope; do not add a company merely to satisfy validation. A discovery
that must be confined to one company would require changing this policy rule.
This limitation does not apply to the human CLI in the same way.

Some product/reference models include companyless records under the reviewed
investigation proposal. Custom models require an enforceable direct company
relationship; the generic extension does not automatically approve arbitrary
parent company paths.

### 5. Metadata completeness

Broker field metadata carries name, type, relation, label and capture provenance.
It does not preserve selection choices, help text, stored/computed status or
the registry's standard/custom classification. `provenance=server` means the
metadata was obtained from the server; it does not mean the field is standard.
An `x_` prefix is a clue, not sufficient provenance for all addon fields.

The brief's field dictionary can begin with existing metadata, marking
standard/custom as unknown where necessary. A human-approved metadata export
can supply details. If repeatable autonomous discovery needs these details,
extend the existing sealed metadata schema and catalog rather than expose raw
admin-model queries to the agent.

### 6. Artwork and aggregate completeness

Broker binary attachment downloads require an approved visible parent, enabled
workspace, and a file of at most 2 MiB. Larger artwork can be listed but not
examined through that route. URL attachments are not automatically retrieved;
business image fields are not a substitute attachment download route.

Category definitions alone do not measure Logo Station throughput. Identify
the Logo Station population first, then count relevant jobs or finished units.
For high-cardinality aggregates, partition by bounded time/ID subsets or compute
from completely paged records. Record limits and reconcile counts before
claiming population coverage. A representative sample only supports sample
frequencies. Distinguish logo component lines, component quantities, unique
designs and actual physical placements.

## Proposed live investigation, pending explicit approval

1. Confirm the instance, permitted companies, date range and read budgets.
   Review the human-sealed policy and any existing captured catalog. Live
   setup itself reads Odoo metadata and needs authorization too.
2. Inspect the approved product, attribute, sales, Helpdesk, BoM and manufacturing
   metadata. Check work-order availability and identify any custom Logo Station
   model. Record enabled, metadata-only, denied and unavailable separately.
3. Resolve `REWESW2-FO1000-05`, `Cotton T-Shirt PLOVER`, `S325806`, `S287206`,
   `S305742`, `04368`, `150383`, `00303`, `33507` and `04185`. Treat these as
   unclassified references, not assumed SKUs or sales-order IDs.
4. Trace a small initial set from customer/request through sales lines,
   templates/variants, BoMs/components, operations and manufacturing/work orders.
   Preserve explicit relation IDs and document unmatched edges.
5. Read relevant instruction fields and page parent-linked chatter, tracking
   and attachments. Examine downloaded content only within the approved scope;
   report oversized or inaccessible material as unexamined.
6. Expand the sample to cover multiple product types, one/multiple logos,
   variants, reorder/reuse, unusual placements and methods where records support
   those distinctions. Label missing evidence rather than inventing examples.
7. Summarize categories over a defined bounded population where feasible.
   Separate finished-SKU reuse, design reuse and BoM reuse.
8. Write `docs/odoo-discovery.md` with record chains, technical fields,
   source-of-truth matrix, category findings and data gaps. Keep observed
   behavior separate from proposed structured placement improvements.

For each evidence capture, retain model, record IDs, projected fields, domain,
ordering/paging, capture timestamp, company scope, broker/catalog revision,
completeness and local attachment path where applicable. A missing record may
reflect record rules or scope; it is not automatically evidence of absence.
Odoo data cannot by itself establish exactly what an operator sees on screen
or physically measures. Document that distinction and corroborate with operator
instructions or user confirmation where necessary.

## Modification decision

No broad rewrite or Logo Station-specific CLI command is justified now.
Start with existing operations and explicit profile configuration. Make a
targeted change when a demonstrated requirement blocks the investigation:

| Trigger | Smallest likely change |
|---|---|
| Work orders needed repeatedly | Add `mrp.workorder` to the existing investigation proposal, retaining metadata reconciliation and company enforcement. |
| Required work-order query blocked on `production_id` | Add a reviewed model-specific bounded anchor, preserving positive-ID/list caps. |
| Essential field unavailable in default projection | Explicit manual approval where supported; otherwise a narrowly reviewed field-selection change. |
| Single-company scope required | Permit a nonempty single-company sealed scope while retaining fixed company injection. |
| Artwork over 2 MiB essential | Add a human-sealed attachment size budget, coordinated with transport/base64/workspace limits; retain linkage checks. |
| Full field semantics required in agent reports | Extend existing sealed metadata with selected registry/fields_get attributes and appropriate version migration. |

These are conditional proposals, not verified deficiencies in FlexiTog's data.
The next step is an explicitly authorized, scoped discovery run, not an
unapproved connectivity or semantics test.

## Local source evidence

Assessment inspected the source under
`/Users/komorinokage/Developer/cli-odoo`:

- `cmd/search.go`, `cmd/read.go`, `cmd/schema.go`, `cmd/diag.go`, `cmd/call.go`,
  `cmd/attach.go`: human read/search/schema/aggregate/attachment capabilities.
- `internal/odoo/client.go`: read-method allowlist and transports.
- `cmd/agentinvestigation.go`, `cmd/agentsetup.go`: proposal, field filter,
  model additions, live metadata reconciliation and setup defaults.
- `internal/agent/policy/{policy,validate,bounded,company}.go`: field/domain,
  query and company enforcement.
- `internal/agent/snapshot/snapshot.go` and
  `internal/agent/broker/{transport,evidence}.go`: sealed metadata, bounded
  aggregates and parent-linked attachment/evidence routes.
- `README.md`, `docs/agent-broker.md`: intended human/agent interfaces.

Validation was static inspection only. No build or test was required for this
documentation-only assessment, and no live Odoo behavior is claimed verified.

## MCP readiness recheck — 2026-10-10

After the local CLI upgrade, snapshot migration and human session renewal,
MCP `meta` and `catalog` both succeeded. The broker reports revision `dev`,
44 catalog models, Odoo snapshot version `17.0+e`, and a matching sealed and
recomputed snapshot digest. This confirms discovery connectivity and snapshot
integrity; it does not verify business read behavior.

The catalog now returns a structured `method_manifest` array, currently empty.
The informational manifest import feature is available, but a source-derived
manifest must be supplied before model methods can be investigated. An empty
manifest does not mean the Odoo models have no methods. Imported entries remain
non-executable and do not grant model or method authorization.

This recheck called only MCP metadata endpoints. No business records were read,
no discovered methods were executed, and no behavior-testing calls were made.

## Discovery retry after tool update — 2026-10-10

Current metadata confirms 45 exposed models, including `mrp.workorder`, under
the same two enabled companies. The sealed/recomputed digest matches. Current
bounded hints admit work-order `production_id`/`operation_id`, stock-move
`production_id`/`raw_material_production_id`/`workorder_id`, and stock-move-line
`production_id`/`workorder_id` anchors. Earlier limitations above are historical
assessments; these specific exposure/anchor gaps are now resolved.

Authorized discovery reads succeeded for three known work orders. Focused
production-ID searches reconciled three work orders and eight component moves
with counts. These were discovery operations, not live automated tests or
method-behavior probes.

The updated catalog reports binary `attachment_evidence` separately from
`readable`. An explicit `field: worksheet` listing on a routing operation
exposed a PDF that ordinary attachment listings had not returned. Related
work-order field listings were empty. Under separate human download approval,
the routing worksheet and two previously listed order artwork/proof files
downloaded successfully; returned SHA-256 hashes match the inspected local
bytes. The tool now declares a 5 MiB download cap and requires an existing
destination parent, created through `workspace_mkdir`.

The current `workspace_read` route returns text rather than a binary encoding;
do not reconstruct PDFs/images from its JSON string. This discovery inspected
the already-downloaded local originals, copied to ignored project paths only
after matching the broker's reported hashes. Do not locate or read unrelated
workspace files or credential/configuration files to obtain binary content.

These corrections enable the current investigation; they do not settle category
population, physical calibration, historical revisions or operator-facing UI.
See `odoo-discovery.md` for findings and the remaining evidence gate.
