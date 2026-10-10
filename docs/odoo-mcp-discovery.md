# MCP model and method discovery for Logo Station

Date: 2026-10-10. Captured through the connected cli-odoo MCP broker.

## Outcome and scope

The connected broker exposes **44 cataloged models**, **3,894 field entries**,
and **9 method-manifest names**. Of the models, **41 permit generic scoped
reads** and **3 are linked-evidence-only**. There are **1,934 generic-readable
field entries** across models; inherited fields can appear on multiple models.

This is the complete catalog returned by this sealed broker profile. It is
**not an exhaustive inventory of installed server models or per-model Python
methods**. The manifest supplies method names without signatures, owning models,
override implementations or per-method provenance. It does not prove that each
name exists on every model and does not authorize execution.

Only MCP `meta({})` and `catalog({})` were called. These return sealed metadata;
they do not perform live business-record discovery. No discovered Odoo method,
record search/read/count/aggregate, evidence fetch or attachment download was
invoked. Upstream Odoo source was inspected separately on GitHub to assess
standard semantics. No CLI code, broker policy or permissions were changed.

## Capture identity

- Instance: `default`.
- Snapshot reports server version: `17.0+e`; not a fresh version call.
- Broker revision: `d4a6171-dirty-local`.
- Policy version: 1.
- Snapshot capture origin: `server`.
- Sealed/recomputed SHA-256 match: true.
- Snapshot digest: `688a17d4c21ae25771bcad1a24a2571ddf5b170d11e2bbdbf78287ff0dbd0d55`.
- Enabled operations: `aggregate`, `count`, `meta`, `read`, `search`.
- Exact evidence is preserved in `odoo-mcp-discovery-snapshot.json`.
- Digest matching establishes snapshot integrity, not freshness or completeness.

## All 44 exposed models, filtered by project relevance

“Core” means a priority for Logo Station discovery; “Support” means follow when
a record chain needs it; “Later” means defer unless evidence makes it relevant.
These roles are interpretation of technical names and metadata, not verified
FlexiTog workflow. Models are not intrinsically read-only: the broker restricts
the allowed operations on them.

The last column is generic-readable fields / cataloged fields. A metadata-only
field is not proof that the field has no data. Evidence-only models show zero
generic-readable fields because their access uses a separate parent-bound route.

| Model | Relevance | Likely purpose | Broker route | Fields |
|---|---|---|---|---|
| `account.account` | Later | Accounting reference | Generic reads | 26/51 |
| `account.journal` | Later | Accounting journal configuration | Generic reads | 40/102 |
| `account.move` | Later | Invoices and accounting documents | Generic reads | 124/254 |
| `account.move.line` | Later | Invoice/accounting lines | Generic reads | 73/110 |
| `account.tax` | Later | Tax configuration | Generic reads | 31/53 |
| `helpdesk.stage` | Core | Request stages | Generic reads | 16/18 |
| `helpdesk.team` | Core | Identify Logo Station team | Generic reads | 48/103 |
| `helpdesk.ticket` | Core | Customer request and instructions | Generic reads | 57/126 |
| `ir.attachment` | Core | Artwork and documents; linked evidence only | Linked evidence | 0/35 |
| `ir.sequence` | Support | SKU/job numbering configuration; read values only | Generic reads | 16/19 |
| `mail.message` | Core | Instructions/history; linked evidence only | Linked evidence | 0/59 |
| `mail.tracking.value` | Core | Tracked revisions; linked evidence only | Linked evidence | 0/21 |
| `mrp.bom` | Core | Finished product recipe, variant and version | Generic reads | 23/52 |
| `mrp.bom.byproduct` | Support | Byproducts if relevant | Generic reads | 14/18 |
| `mrp.bom.line` | Core | Base garment/logo components and quantities | Generic reads | 16/26 |
| `mrp.production` | Core | Manufacturing jobs | Generic reads | 42/133 |
| `mrp.routing.workcenter` | Core | Operations, instructions and worksheets | Generic reads | 20/28 |
| `mrp.workcenter` | Core | Production station definitions | Generic reads | 25/46 |
| `product.attribute` | Core | Variant dimensions/axes | Generic reads | 17/22 |
| `product.attribute.value` | Core | Variant choices | Generic reads | 13/17 |
| `product.category` | Core | Category hierarchy | Generic reads | 15/32 |
| `product.pricelist` | Later | Customer pricing/catalog restrictions | Generic reads | 21/50 |
| `product.pricelist.item` | Later | Product/customer pricing rules | Generic reads | 32/37 |
| `product.product` | Core | Concrete variants and SKUs | Generic reads | 40/410 |
| `product.template` | Core | Product family, customization and artwork metadata | Generic reads | 190/331 |
| `product.template.attribute.line` | Core | Template attribute structure | Generic reads | 11/13 |
| `product.template.attribute.value` | Core | Template/variant attribute linkage | Generic reads | 13/22 |
| `purchase.order` | Support | Supplier or subcontract job context | Generic reads | 67/126 |
| `purchase.order.line` | Support | Supplier product/component lines | Generic reads | 43/60 |
| `res.partner` | Core | Customer ownership and logo vendors | Generic reads | 244/425 |
| `sale.order` | Core | Customer job/order context | Generic reads | 125/226 |
| `sale.order.line` | Core | Requested products, variants and instructions | Generic reads | 71/109 |
| `stock.location` | Support | Production/pre-production locations | Generic reads | 31/42 |
| `stock.lot` | Support | Lot traceability | Generic reads | 18/57 |
| `stock.move` | Support | Manufacturing components/outputs and sale linkage | Generic reads | 73/115 |
| `stock.move.line` | Support | Physical movement and work-order links | Generic reads | 41/87 |
| `stock.picking` | Support | Pre-production/transfers and delivery chain | Generic reads | 71/172 |
| `stock.picking.type` | Support | Operation types | Generic reads | 76/94 |
| `stock.quant` | Later | Current stock quantities | Generic reads | 24/47 |
| `stock.route` | Later | Routing rules context | Generic reads | 21/24 |
| `stock.rule` | Later | Procurement configuration | Generic reads | 26/30 |
| `stock.warehouse` | Support | Warehouse and production setup | Generic reads | 59/62 |
| `uom.category` | Core | Unit categories | Generic reads | 7/10 |
| `uom.uom` | Core | Quantities, unit definitions and rounding | Generic reads | 14/20 |

## All nine manifested methods and mutation assessment

Confidence applies to standard Odoo 17 intent, not deployed custom overrides.
“Likely read” means no intended business mutation in the upstream implementation.
It is not certification of strict SQL read-only execution: ORM internals,
computed fields, overrides and addons may introduce side effects. No deployed
implementation was executed or inspected.

| Manifest name | Standard purpose | Assessment | Confidence | Broker exposure |
|---|---|---|---|---|
| `search_read` | Select matching records and return projected fields | Likely read | High | Typed search; typed read also uses scoped search_read |
| `read` | Return fields for supplied record IDs | Likely read | High | No raw read endpoint; typed read maps to scoped search_read |
| `search_count` | Count matching records | Likely read | High | Typed count |
| `read_group` | Group records and calculate aggregates | Likely read | High | Typed aggregate, subject to model permission |
| `fields_get` | Describe field definitions | Likely metadata read | High | Sealed meta/catalog; no arbitrary live invocation |
| `name_search` | Find ID/display-name pairs | Likely read | High | Manifest only; no dedicated broker operation |
| `check_access_rights` | Check model ACL permission, without performing that operation | Likely authorization read | High | Manifest only; no dedicated broker operation |
| `version` | Return server/version information | Likely metadata read | High | Common service semantics; not a general model method |
| `context_get` | Return current user context | Likely context read | High | res.users semantics; not a general model method |

The standard ORM purposes above were checked against [Odoo 17 models.py](https://github.com/odoo/odoo/blob/17.0/odoo/models.py).
The version entry was checked against [common service source](https://github.com/odoo/odoo/blob/17.0/odoo/service/common.py);
user context against [res.users source](https://github.com/odoo/odoo/blob/17.0/odoo/addons/base/models/res_users.py).
These public sources are a baseline, not the source of FlexiTog's deployed addons.

**Relevant read shortlist:** `search_read`, `search_count`, `read_group`, and
field metadata via sealed `meta/catalog`. The broker's typed `read` supplies
ID-based reading with enforced company scope. `name_search` could be useful for
interactive lookup but is not exposed as a callable broker operation.

**No likely mutating method was present in the returned manifest.** No custom
business method names were exposed. This result says nothing about unlisted
methods. Keep any newly supplied custom method “unknown / do not execute” until
its deployment-specific implementation and called helpers are reviewed.
Names such as “get”, “compute” or “report” alone are insufficient evidence of
non-mutation.

## High-value field leads observed in the catalog

These are metadata facts, not observations of field values or workflow usage.

| Field | Type / relation | Value permission | Catalog label |
|---|---|---|---|
| `product.template.customize_product` | many2one → `product.template` | Readable | Customize Product |
| `product.template.partner_ids` | many2many → `res.partner` | Readable | Partners |
| `product.template.designation_product_category` | selection | Readable | Category |
| `product.template.x_studio_brandingartwork` | binary | Metadata only | x_studio_brandingartwork |
| `product.template.x_studio_brandingartwork_filename` | char | Readable | Filename for x_studio_binary_field_k333i |
| `product.template.x_studio_tech_pack` | binary | Metadata only | x_studio_tech_pack |
| `product.template.x_studio_tech_pack_filename` | char | Readable | Filename for x_studio_binary_field_BuGl7 |
| `product.template.x_studio_pattern` | binary | Metadata only | x_studio_pattern |
| `sale.order.already_has_logo` | boolean | Readable | FlexiTog already has my logo |
| `sale.order.line.customer_message` | char | Readable | Customer Message |
| `res.partner.is_logo_vendor` | boolean | Readable | Is Logo-Vendor |
| `res.partner.logo_vendor_email_content` | html | Readable | Email Content |
| `mrp.bom.previous_bom_id` | many2one → `mrp.bom` | Readable | Previous BoM |
| `mrp.bom.version` | integer | Readable | Version |
| `mrp.bom.line.bom_product_template_attribute_value_ids` | many2many → `product.template.attribute.value` | Readable | Apply on Variants |
| `mrp.routing.workcenter.note` | html | Readable | Description |
| `mrp.routing.workcenter.worksheet` | binary | Metadata only | worksheet |
| `mrp.routing.workcenter.worksheet_type` | selection | Readable | Worksheet |
| `mrp.routing.workcenter.worksheet_google_slide` | char | Readable | Google Slide |
| `mrp.production.workorder_ids` | one2many → `mrp.workorder` | Metadata only | workorder_ids |
| `stock.move.workorder_id` | many2one → `mrp.workorder` | Readable | Work Order To Consume |
| `sale.order.line.request_line` | many2one → `emp.product.request` | Readable | Employee Request |

Interpretation for the project:

- `customize_product` is a candidate link between customized and other product
  templates; its direction and business meaning require later record evidence.
- Branding artwork, pattern and tech-pack binaries exist in product-template
  metadata but are not readable through the current generic broker route.
  A readable filename is not proof that a binary is populated. Do not assume
  those fields can automatically be retrieved as parent-linked attachments.
- BoM version/previous-BoM fields offer a candidate revision chain; actual use
  remains unverified.
- Operation `note` and worksheet metadata are strong candidates for production
  instructions. Binary worksheets are currently metadata-only. A Google Slide
  field value would be a separate external document, not automatically fetched.
- `already_has_logo`, logo-vendor flags and customer-message fields suggest
  useful discovery entry points; they do not establish the logo data model.
- `website_size_x/y` have website size labels and must not be treated as physical
  millimetre measurements without separate evidence.

## Related models mentioned but not exposed

The catalog contains relationship targets outside the sealed model inventory.
They are discoverable references, not approved models or independently verified
available record endpoints. Relevant candidates include:

| Referenced target | Metadata evidence | Likely relevance |
|---|---|---|
| `mrp.workorder` | `mrp.production.workorder_ids`, `stock.move.workorder_id` | Actual production execution and operator work orders |
| `product.document` | `product.template.product_document_ids` | Product documents |
| `website.product.attachment.download` | `product.template.file_attachment_id` | Additional document/artwork source candidate |
| `product.attribute.set` | `product.template.attribute_set_id` | Product attribute grouping |
| `product.attribute_desc.lines` | `product.template.attribute_line_desc_ids` | Attribute descriptions |
| `product.attribute.custom.value` | `sale.order.line.product_custom_attribute_value_ids` | Per-order customized values |
| `emp.product.request` | `sale.order.line.request_line` | Request linkage; actual relationship to Logo Station unknown |
| `mrp.eco` | `mrp.bom.eco_ids` | Engineering changes/revisions |
| `quality.check` | `mrp.production.check_ids` | Production checks if required |
| `helpdesk.ticket.type` | `helpdesk.ticket.ticket_type_id` | Request classification |

The full list of unexposed relationship targets and their source fields is
included in the JSON snapshot. No referenced target was queried.

## Fit and next discovery requirement

The current broker already offers the generic read operations needed for the
core discovery. The concrete metadata gaps are work-order exposure, binary
artwork/worksheet access, and possibly additional request/document models.
No custom method execution is needed to establish these leads.

To list **every installed model and every deployed method**, obtain a
human-approved deployment inventory or deployment-specific addon source.
The current MCP surface cannot enumerate that universe. A future improvement
could import a bounded, informational manifest with model, method, signature,
source module/revision and source reference. It should remain non-executable
and keep authorization separate. Do not grant arbitrary calls to perform
introspection or test a method's behavior.

This phase is complete for all metadata exposed by the connected profile.
Actual record-chain discovery and any expansion of permissions remain separate
from this metadata-only investigation.

