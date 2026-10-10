# Model and method investigation without deployed source

MCP metadata rechecked on 2026-10-10: 44 exposed catalog models and an empty deployed method manifest. These are the sealed catalog models, not a complete list of installed Odoo models. No business records were read and no discovered methods were executed.

## What this investigation establishes

The model/field metadata confirms catalog presence, field types and permitted projections. It does not reveal Python method names, signatures, implementations or override chains. Relationship targets can suggest additional models, but do not confirm their availability or grant permission to read them. There is no remote method-enumeration operation in the current broker.

Public Odoo 17 source provides reference candidates. This inventory scans seven selected source files covering eight model classes; it excludes unscanned addons, inherited base/mixin methods, Enterprise and custom methods. It is not exhaustive even for the eight models. The fetched reference revision is bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76; this is not the deployed revision.

## Reference inventory

385 definitions extracted using Python AST parsing only. No downloaded Python module was imported or executed. Assessments describe the public implementation; actual deployed behavior remains unknown.

| Assessment | Entries |
|---|---:|
| likely_read_only | 10 |
| likely_mutating | 23 |
| unknown | 352 |

## Project-relevant candidates

Private helpers are included for understanding behavior; they are not RPC-call recommendations. Read-looking names can still mutate. A UI action that only returns a dictionary can be informational, while the later action it opens may write records.

| Model | Method | Public-source assessment | Purpose / evidence |
|---|---|---|
| product.template | [`action_open_documents`](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L629) | likely_read_only | Returns a UI action for product documents. Returns an action dictionary with context/domain; no document creation or download occurs in the inspected body. Field dependencies and overrides are unverified. |
| product.template | [`_is_combination_possible`](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1058) | unknown | Checks whether attribute values form an allowed combination.  |
| product.template | [`_get_variant_for_combination`](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1111) | likely_read_only | Returns an existing variant matching a combination. Delegates to _get_variant_id_for_combination and browse after filtering no-variant attributes; no creation in the inspected body. Dependencies remain unverified. |
| product.template | [`_create_product_variant`](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1127) | likely_mutating | Creates a dynamic variant or reactivates an archived variant. Assigns product_variant.active=True and can call Product.sudo().create(...). |
| product.template | [`_create_first_product_variant`](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1174) | likely_mutating | Creates or retrieves the first possible variant. Calls _create_product_variant, which can create or reactivate a product. |
| product.template | [`_get_variant_id_for_combination`](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1187) | likely_read_only | Searches for an existing variant matching attribute values. Builds a domain and returns a search result ID; uses sudo and active_test=False. Helpers and deployed overrides are unverified. |
| product.template | [`_get_first_possible_variant_id`](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1205) | likely_mutating | Returns a first possible variant ID, potentially creating a variant. Calls _create_first_product_variant, whose implementation calls _create_product_variant; this can create or reactivate a product. |
| product.template | [`_get_possible_combinations`](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1328) | unknown | Generates possible combinations from configured attributes and exclusions.  |
| product.template | [`get_single_product_variant`](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1429) | likely_read_only | Returns the sole variant when the template does not require configuration. Returns an ID/name dictionary or an empty dictionary using field values; deployed overrides and computed field dependencies are unverified. |
| product.product | [`action_open_documents`](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L640) | likely_read_only | Returns a UI action for variant documents. Calls the reviewed template action and changes the returned dictionary context; no ORM write in the inspected body. Deployed overrides are unverified. |
| product.product | [`get_product_multiline_description_sale`](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L770) | likely_read_only | Combines the display name and sales description. Reads display_name and description_sale and builds a string; field dependencies and deployed overrides are unverified. |
| mrp.bom | [`action_compute_bom_days`](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L298) | likely_mutating | Calculates and stores BoM preparation lead time. Assigns bom.days_to_prepare_mo, which is an ORM field assignment. |
| mrp.bom | [`_bom_find_domain`](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L327) | likely_read_only | Builds selection conditions for matching a product to a BoM. Builds and returns a domain using existing product IDs and context; no record assignment or write in the inspected body. |
| mrp.bom | [`_bom_find`](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L338) | likely_read_only | Finds the first matching BoM per product. Calls _bom_find_domain and search; builds an in-memory mapping. Deployment overrides and field access dependencies are unverified. |
| mrp.bom | [`explode`](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L369) | unknown | Expands component quantities, including nested phantom BoMs.  |
| mrp.routing.workcenter | [`copy_to_bom`](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_routing.py#L138) | likely_mutating | Copies routing operations into another BoM. Calls operation.copy with a bom_id when the context supplies a target BoM. |
| mrp.routing.workcenter | [`copy_existing_operations`](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_routing.py#L151) | likely_read_only | Returns a selection window for choosing operations to copy later. Returns an action dictionary only. The subsequent copy_to_bom action mutates data, but this inspected body does not perform the copy. |
| mrp.routing.workcenter | [`_skip_operation_line`](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_routing.py#L164) | unknown | Determines whether an operation applies to a product variant.  |
| mrp.routing.workcenter | [`_get_comparison_values`](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_routing.py#L176) | likely_read_only | Returns a tuple of routing-operation values for comparison. Returns field values in a tuple; no write in the inspected body. Field dependencies and overrides are unverified. |

## Implications for Logo Station

Prefer the existing bounded search/read/aggregate routes for products, attribute values, BoMs, BoM lines and routing operations. Matching products and reading component/operation records does not require opening arbitrary model calls. Metadata alone cannot establish the actual Logo Station workflow or how the custom fields are populated.

Fields such as customize_product, already_has_logo, branding assets, version/previous_bom_id, and routing notes are project leads; they do not justify inventing custom method names or declaring their behavior safe. Methods responsible for them remain unknown.

## Import and further discovery

`methods.upstream-reference.json` is an informational, importable candidate manifest. Importing it would replace the existing empty manifest. It has not been applied to the live broker; doing so requires the existing human admin unlock. Every served entry remains executable:false, regardless of its assessment.

Obtaining a true deployed method list requires implementation metadata from the deployment owner: a source export or a narrow server-side inventory exporter that emits names/signatures/provenance without invoking the listed methods. A broker-only change cannot infer inaccessible Python implementations. A future registry-model inventory could expose additional model/field/module metadata under a separately bounded metadata operation; it still would not expose arbitrary Python methods.

## Full selected-source method inventory

| Model | Method | Assessment | Source |
|---|---|---|---|
| product.template | `_get_default_category_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L25) |
| product.template | `_get_default_uom_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L30) |
| product.template | `_read_group_categ_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L34) |
| product.template | `_compute_uom_po_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L162) |
| product.template | `_compute_item_count` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L167) |
| product.template | `_compute_product_document_count` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L176) |
| product.template | `_compute_can_image_1024_be_zoomed` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L187) |
| product.template | `_compute_has_configurable_attributes` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L198) |
| product.template | `_compute_product_variant_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L216) |
| product.template | `_check_barcode_uniqueness` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L221) |
| product.template | `_compute_currency_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L226) |
| product.template | `_compute_cost_currency_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L233) |
| product.template | `_compute_template_field_from_variant_field` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L238) |
| product.template | `_set_product_variant_field` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L261) |
| product.template | `_compute_standard_price` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L281) |
| product.template | `_set_standard_price` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L286) |
| product.template | `_search_standard_price` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L289) |
| product.template | `_compute_volume` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L293) |
| product.template | `_set_volume` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L296) |
| product.template | `_compute_weight` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L300) |
| product.template | `_set_weight` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L303) |
| product.template | `_compute_is_product_variant` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L306) |
| product.template | `_compute_barcode` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L310) |
| product.template | `_search_barcode` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L313) |
| product.template | `_set_barcode` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L319) |
| product.template | `_get_weight_uom_id_from_ir_config_parameter` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L323) |
| product.template | `_get_length_uom_id_from_ir_config_parameter` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L336) |
| product.template | `_get_volume_uom_id_from_ir_config_parameter` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L349) |
| product.template | `_get_weight_uom_name_from_ir_config_parameter` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L362) |
| product.template | `_get_length_uom_name_from_ir_config_parameter` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L366) |
| product.template | `_get_volume_uom_name_from_ir_config_parameter` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L370) |
| product.template | `_compute_weight_uom_name` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L374) |
| product.template | `_compute_volume_uom_name` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L378) |
| product.template | `_compute_product_variant_count` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L382) |
| product.template | `_onchange_default_code` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L387) |
| product.template | `_compute_default_code` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L402) |
| product.template | `_set_default_code` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L405) |
| product.template | `_compute_packaging_ids` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L409) |
| product.template | `_set_packaging_ids` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L416) |
| product.template | `_compute_product_tooltip` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L422) |
| product.template | `_detailed_type_mapping` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L432) |
| product.template | `_compute_type` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L436) |
| product.template | `_constrains_detailed_type` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L442) |
| product.template | `_check_uom` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L449) |
| product.template | `_onchange_uom_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L454) |
| product.template | `_onchange_type` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L459) |
| product.template | `_sanitize_vals` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L463) |
| product.template | `_get_related_fields_variant_template` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L477) |
| product.template | `create` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L482) |
| product.template | `write` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L501) |
| product.template | `copy` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L520) |
| product.template | `_compute_display_name` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L541) |
| product.template | `_name_search` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L549) |
| product.template | `action_open_label_layout` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L603) |
| product.template | `open_pricelist_rules` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L608) |
| product.template | `action_open_documents` | likely_read_only | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L629) |
| product.template | `_get_product_price_context` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L673) |
| product.template | `_get_attributes_extra_price` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L689) |
| product.template | `_price_compute` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L694) |
| product.template | `_create_variant_ids` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L727) |
| product.template | `_prepare_variant_values` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L821) |
| product.template | `has_dynamic_attributes` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L829) |
| product.template | `_compute_valid_product_template_attribute_line_ids` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L840) |
| product.template | `_get_possible_variants` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L852) |
| product.template | `_get_attribute_exclusions` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L876) |
| product.template | `_complete_inverse_exclusions` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L925) |
| product.template | `_get_own_attribute_exclusions` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L940) |
| product.template | `_get_parent_attribute_exclusions` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L962) |
| product.template | `_get_mapped_attribute_names` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L987) |
| product.template | `_filter_combinations_impossible_by_config` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1005) |
| product.template | `_is_combination_possible_by_config` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1042) |
| product.template | `_is_combination_possible` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1058) |
| product.template | `_get_variant_for_combination` | likely_read_only | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1111) |
| product.template | `_create_product_variant` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1127) |
| product.template | `_create_first_product_variant` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1174) |
| product.template | `_get_variant_id_for_combination` | likely_read_only | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1187) |
| product.template | `_get_first_possible_variant_id` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1205) |
| product.template | `_get_first_possible_combination` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1211) |
| product.template | `_cartesian_product` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1224) |
| product.template | `_get_possible_combinations` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1328) |
| product.template | `_get_closest_possible_combination` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1377) |
| product.template | `_get_closest_possible_combinations` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1390) |
| product.template | `_get_placeholder_filename` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1423) |
| product.template | `get_single_product_variant` | likely_read_only | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1429) |
| product.template | `get_empty_list_help` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1447) |
| product.template | `get_import_templates` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1454) |
| product.template | `get_contextual_price` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1460) |
| product.template | `_get_contextual_price` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1463) |
| product.template | `_get_contextual_pricelist` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_template.py#L1471) |
| product.product | `_compute_can_image_variant_1024_be_zoomed` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L108) |
| product.product | `_set_template_field` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L112) |
| product.product | `_compute_write_date` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L133) |
| product.product | `_compute_image_1920` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L155) |
| product.product | `_set_image_1920` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L160) |
| product.product | `_compute_image_1024` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L163) |
| product.product | `_compute_image_512` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L168) |
| product.product | `_compute_image_256` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L173) |
| product.product | `_compute_image_128` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L178) |
| product.product | `_compute_can_image_1024_be_zoomed` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L183) |
| product.product | `_get_placeholder_filename` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L188) |
| product.product | `init` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L194) |
| product.product | `_get_barcodes_by_company` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L202) |
| product.product | `_get_barcode_search_domain` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L208) |
| product.product | `_check_duplicated_product_barcodes` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L214) |
| product.product | `_check_duplicated_packaging_barcodes` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L231) |
| product.product | `_check_barcode_uniqueness` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L237) |
| product.product | `_get_invoice_policy` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L245) |
| product.product | `_compute_combination_indices` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L249) |
| product.product | `_compute_is_product_variant` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L253) |
| product.product | `_set_product_lst_price` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L257) |
| product.product | `_compute_product_price_extra` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L267) |
| product.product | `_compute_product_lst_price` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L273) |
| product.product | `_compute_product_code` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L286) |
| product.product | `_compute_partner_ref` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L302) |
| product.product | `_compute_variant_item_count` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L312) |
| product.product | `_compute_product_document_count` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L322) |
| product.product | `_compute_all_product_tag_ids` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L330) |
| product.product | `_search_all_product_tag_ids` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L334) |
| product.product | `_onchange_uom_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L340) |
| product.product | `_onchange_uom` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L345) |
| product.product | `_onchange_default_code` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L350) |
| product.product | `create` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L365) |
| product.product | `write` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L373) |
| product.product | `unlink` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L384) |
| product.product | `_filter_to_unlink` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L416) |
| product.product | `_unlink_or_archive` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L419) |
| product.product | `copy` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L458) |
| product.product | `_search` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L473) |
| product.product | `_compute_display_name` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L482) |
| product.product | `_name_search` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L543) |
| product.product | `view_header_get` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L594) |
| product.product | `action_open_label_layout` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L604) |
| product.product | `open_pricelist_rules` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L609) |
| product.product | `open_product_template` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L629) |
| product.product | `action_open_documents` | likely_read_only | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L640) |
| product.product | `_prepare_sellers` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L651) |
| product.product | `_get_filtered_sellers` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L655) |
| product.product | `_select_seller` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L682) |
| product.product | `_get_product_price_context` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L706) |
| product.product | `_get_attributes_extra_price` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L725) |
| product.product | `_price_compute` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L731) |
| product.product | `get_empty_list_help` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L764) |
| product.product | `get_product_multiline_description_sale` | likely_read_only | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L770) |
| product.product | `_is_variant_possible` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L781) |
| product.product | `toggle_active` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L797) |
| product.product | `get_contextual_price` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L810) |
| product.product | `_get_contextual_price` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L813) |
| product.product | `_get_contextual_discount` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/product/models/product_product.py#L817) |
| mrp.bom | `_get_default_product_uom_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L23) |
| mrp.bom | `_compute_possible_product_template_attribute_value_ids` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L103) |
| mrp.bom | `_onchange_product_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L108) |
| mrp.bom | `_check_bom_cycle` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L115) |
| mrp.bom | `_check_bom_lines` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L167) |
| mrp.bom | `onchange_bom_structure` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L193) |
| mrp.bom | `onchange_product_uom_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L205) |
| mrp.bom | `onchange_product_tmpl_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L215) |
| mrp.bom | `create` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L235) |
| mrp.bom | `write` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L246) |
| mrp.bom | `copy` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L255) |
| mrp.bom | `name_create` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L278) |
| mrp.bom | `toggle_active` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L289) |
| mrp.bom | `_compute_display_name` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L294) |
| mrp.bom | `action_compute_bom_days` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L298) |
| mrp.bom | `check_kit_has_not_orderpoint` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L315) |
| mrp.bom | `_unlink_except_running_mo` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L322) |
| mrp.bom | `_bom_find_domain` | likely_read_only | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L327) |
| mrp.bom | `_bom_find` | likely_read_only | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L338) |
| mrp.bom | `explode` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L369) |
| mrp.bom | `get_import_templates` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L426) |
| mrp.bom | `_set_outdated_bom_in_productions` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L432) |
| mrp.bom.line | `_get_default_product_uom_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L470) |
| mrp.bom.line | `_compute_manual_consumption` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L525) |
| mrp.bom.line | `_compute_manual_consumption_readonly` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L530) |
| mrp.bom.line | `_compute_child_bom_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L535) |
| mrp.bom.line | `_compute_attachments_count` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L545) |
| mrp.bom.line | `_compute_child_line_ids` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L554) |
| mrp.bom.line | `onchange_product_uom_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L560) |
| mrp.bom.line | `onchange_product_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L570) |
| mrp.bom.line | `create` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L575) |
| mrp.bom.line | `_skip_bom_line` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L581) |
| mrp.bom.line | `action_see_attachments` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L590) |
| mrp.bom.byproduct | `_compute_product_uom_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L647) |
| mrp.bom.byproduct | `_skip_byproduct_line` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_bom.py#L652) |
| mrp.routing.workcenter | `_compute_time_computed_on` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_routing.py#L63) |
| mrp.routing.workcenter | `_compute_time_cycle` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_routing.py#L68) |
| mrp.routing.workcenter | `_compute_workorder_count` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_routing.py#L96) |
| mrp.routing.workcenter | `_check_no_cyclic_dependencies` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_routing.py#L105) |
| mrp.routing.workcenter | `create` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_routing.py#L110) |
| mrp.routing.workcenter | `write` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_routing.py#L115) |
| mrp.routing.workcenter | `action_archive` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_routing.py#L124) |
| mrp.routing.workcenter | `action_unarchive` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_routing.py#L133) |
| mrp.routing.workcenter | `copy_to_bom` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_routing.py#L138) |
| mrp.routing.workcenter | `copy_existing_operations` | likely_read_only | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_routing.py#L151) |
| mrp.routing.workcenter | `_skip_operation_line` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_routing.py#L164) |
| mrp.routing.workcenter | `_get_comparison_values` | likely_read_only | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/mrp/models/mrp_routing.py#L176) |
| sale.order | `_rec_names_search` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L44) |
| sale.order | `init` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L298) |
| sale.order | `_compute_display_name` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L305) |
| sale.order | `_compute_require_signature` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L315) |
| sale.order | `_compute_require_payment` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L320) |
| sale.order | `_compute_prepayment_percent` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L325) |
| sale.order | `_compute_validity_date` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L330) |
| sale.order | `_compute_journal_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L339) |
| sale.order | `_compute_note` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L343) |
| sale.order | `_get_note_url` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L360) |
| sale.order | `_compute_partner_invoice_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L364) |
| sale.order | `_compute_partner_shipping_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L369) |
| sale.order | `_compute_fiscal_position_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L374) |
| sale.order | `_compute_payment_term_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L394) |
| sale.order | `_compute_pricelist_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L400) |
| sale.order | `_compute_currency_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L411) |
| sale.order | `_compute_currency_rate` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L416) |
| sale.order | `_compute_has_active_pricelist` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L426) |
| sale.order | `_compute_user_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L434) |
| sale.order | `_compute_team_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L447) |
| sale.order | `_compute_amounts` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L470) |
| sale.order | `_get_invoiced` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L493) |
| sale.order | `_search_invoice_ids` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L503) |
| sale.order | `_compute_invoice_status` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L540) |
| sale.order | `_compute_authorized_transaction_ids` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L588) |
| sale.order | `_compute_amount_paid` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L593) |
| sale.order | `_compute_amount_undiscounted` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L600) |
| sale.order | `_compute_expected_date` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L608) |
| sale.order | `_select_expected_date` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L625) |
| sale.order | `_compute_is_expired` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L629) |
| sale.order | `_compute_tax_country_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L639) |
| sale.order | `_compute_amount_to_invoice` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L647) |
| sale.order | `_compute_amount_invoiced` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L661) |
| sale.order | `_compute_partner_credit_warning` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L666) |
| sale.order | `_compute_tax_totals` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L680) |
| sale.order | `_compute_type_name` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L690) |
| sale.order | `_compute_access_url` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L698) |
| sale.order | `_check_order_line_company_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L706) |
| sale.order | `_check_prepayment_percent` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L723) |
| sale.order | `onchange` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L730) |
| sale.order | `_onchange_commitment_date` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L742) |
| sale.order | `_onchange_company_id_warning` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L754) |
| sale.order | `_onchange_fpos_id_show_update_fpos` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L769) |
| sale.order | `_onchange_partner_id_warning` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L777) |
| sale.order | `_onchange_pricelist_id_show_update_prices` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L803) |
| sale.order | `_onchange_prepayment_percent` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L807) |
| sale.order | `create` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L814) |
| sale.order | `copy_data` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L827) |
| sale.order | `write` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L837) |
| sale.order | `_unlink_except_draft_or_cancel` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L843) |
| sale.order | `action_open_discount_wizard` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L852) |
| sale.order | `action_draft` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L862) |
| sale.order | `action_quotation_send` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L871) |
| sale.order | `_find_mail_template` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L900) |
| sale.order | `_get_confirmation_template` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L915) |
| sale.order | `action_quotation_sent` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L931) |
| sale.order | `action_confirm` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L944) |
| sale.order | `_should_be_locked` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L984) |
| sale.order | `_can_be_confirmed` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L989) |
| sale.order | `_prepare_confirmation_values` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L993) |
| sale.order | `_action_confirm` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1006) |
| sale.order | `_send_order_confirmation_mail` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1017) |
| sale.order | `_send_payment_succeeded_for_order_mail` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1026) |
| sale.order | `_send_order_notification_mail` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1037) |
| sale.order | `action_lock` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1060) |
| sale.order | `action_unlock` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1063) |
| sale.order | `action_cancel` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1066) |
| sale.order | `_action_cancel` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1104) |
| sale.order | `_show_cancel_wizard` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1109) |
| sale.order | `action_preview_sale_order` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1119) |
| sale.order | `action_update_taxes` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1127) |
| sale.order | `_recompute_taxes` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1137) |
| sale.order | `action_update_prices` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1142) |
| sale.order | `_recompute_prices` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1154) |
| sale.order | `_default_order_line_values` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1165) |
| sale.order | `_get_action_add_from_catalog_extra_context` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1170) |
| sale.order | `_get_product_catalog_domain` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1177) |
| sale.order | `_prepare_invoice` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1182) |
| sale.order | `action_view_invoice` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1215) |
| sale.order | `_get_invoice_grouping_keys` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1243) |
| sale.order | `_nothing_to_invoice_error_message` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1246) |
| sale.order | `_get_update_prices_lines` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1257) |
| sale.order | `_get_invoiceable_lines` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1261) |
| sale.order | `_create_account_invoices` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1288) |
| sale.order | `_create_invoices` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1294) |
| sale.order | `_track_finalize` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1484) |
| sale.order | `message_post` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1497) |
| sale.order | `_notify_get_recipients_groups` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1505) |
| sale.order | `_notify_by_email_prepare_rendering_context` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1542) |
| sale.order | `_phone_get_number_fields` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1566) |
| sale.order | `_track_subtype` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1571) |
| sale.order | `_force_lines_to_invoice_policy_order` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1581) |
| sale.order | `payment_action_capture` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1593) |
| sale.order | `payment_action_void` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1601) |
| sale.order | `get_portal_last_transaction` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1608) |
| sale.order | `_get_order_lines_to_report` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1612) |
| sale.order | `_get_default_payment_link_values` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1631) |
| sale.order | `_has_to_be_signed` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1659) |
| sale.order | `_has_to_be_paid` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1679) |
| sale.order | `_get_portal_return_action` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1702) |
| sale.order | `_get_name_portal_content_view` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1707) |
| sale.order | `_get_name_tax_totals_view` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1712) |
| sale.order | `_get_report_base_filename` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1716) |
| sale.order | `get_empty_list_help` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1723) |
| sale.order | `_compute_field_value` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1729) |
| sale.order | `_create_upsell_activity` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1744) |
| sale.order | `_prepare_analytic_account_data` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1757) |
| sale.order | `_create_analytic_account` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1781) |
| sale.order | `_prepare_down_payment_section_line` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1792) |
| sale.order | `_get_prepayment_required_amount` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1815) |
| sale.order | `_is_confirmation_amount_reached` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1829) |
| sale.order | `_generate_downpayment_invoices` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1843) |
| sale.order | `_get_product_catalog_order_data` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1861) |
| sale.order | `_get_product_catalog_record_lines` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1878) |
| sale.order | `_get_product_documents` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1886) |
| sale.order | `_filter_product_documents` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1895) |
| sale.order | `_update_order_line_info` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1902) |
| sale.order | `add_option_to_order_with_taxcloud` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1937) |
| sale.order | `validate_taxes_on_sales_order` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1940) |
| sale.order | `_is_readonly` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1947) |
| sale.order | `_is_paid` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1959) |
| sale.order | `_get_lang` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order.py#L1971) |
| sale.order.line | `_compute_display_name` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L268) |
| sale.order.line | `_compute_product_template_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L278) |
| sale.order.line | `_search_product_template_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L282) |
| sale.order.line | `_compute_custom_attribute_values` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L286) |
| sale.order.line | `_compute_no_variant_attribute_values` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L300) |
| sale.order.line | `_compute_name` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L314) |
| sale.order.line | `_get_sale_order_line_multiline_description_sale` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L343) |
| sale.order.line | `_get_sale_order_line_multiline_description_variants` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L356) |
| sale.order.line | `_compute_product_uom_qty` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L398) |
| sale.order.line | `_compute_product_uom` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L414) |
| sale.order.line | `_compute_tax_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L420) |
| sale.order.line | `_get_custom_compute_tax_cache_key` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L445) |
| sale.order.line | `_compute_pricelist_item_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L450) |
| sale.order.line | `_compute_price_unit` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L463) |
| sale.order.line | `_get_order_date` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L486) |
| sale.order.line | `_get_display_price` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L490) |
| sale.order.line | `_get_pricelist_price` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L515) |
| sale.order.line | `_get_product_price_context` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L534) |
| sale.order.line | `_get_pricelist_price_context` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L545) |
| sale.order.line | `_get_pricelist_price_before_discount` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L555) |
| sale.order.line | `_compute_discount` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L573) |
| sale.order.line | `_convert_to_tax_base_line_dict` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L603) |
| sale.order.line | `_compute_amount` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L624) |
| sale.order.line | `_compute_price_reduce_taxexcl` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L643) |
| sale.order.line | `_compute_price_reduce_taxinc` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L648) |
| sale.order.line | `_compute_product_packaging_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L653) |
| sale.order.line | `_compute_product_packaging_qty` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L666) |
| sale.order.line | `_compute_customer_lead` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L676) |
| sale.order.line | `_compute_qty_delivered_method` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L680) |
| sale.order.line | `_compute_qty_delivered` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L700) |
| sale.order.line | `_get_downpayment_state` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L713) |
| sale.order.line | `_get_delivered_quantity_by_analytic` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L729) |
| sale.order.line | `_compute_qty_invoiced` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L764) |
| sale.order.line | `_get_invoice_lines` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L781) |
| sale.order.line | `_compute_qty_to_invoice` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L792) |
| sale.order.line | `_compute_invoice_status` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L807) |
| sale.order.line | `_can_be_invoiced_alone` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L837) |
| sale.order.line | `_is_discount_line` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L847) |
| sale.order.line | `_compute_untaxed_amount_invoiced` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L852) |
| sale.order.line | `_compute_untaxed_amount_to_invoice` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L872) |
| sale.order.line | `_compute_analytic_distribution` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L920) |
| sale.order.line | `_compute_product_updatable` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L933) |
| sale.order.line | `_compute_product_uom_readonly` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L947) |
| sale.order.line | `_onchange_product_id_warning` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L957) |
| sale.order.line | `_onchange_product_packaging_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L974) |
| sale.order.line | `create` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L994) |
| sale.order.line | `write` | likely_mutating | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L1013) |
| sale.order.line | `_get_protected_fields` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L1059) |
| sale.order.line | `_update_line_quantity` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L1070) |
| sale.order.line | `_check_line_unlink` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L1091) |
| sale.order.line | `_unlink_except_confirmed` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L1109) |
| sale.order.line | `action_add_from_catalog` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L1116) |
| sale.order.line | `_expected_date` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L1122) |
| sale.order.line | `compute_uom_qty` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L1130) |
| sale.order.line | `_get_invoice_line_sequence` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L1133) |
| sale.order.line | `_prepare_invoice_line` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L1145) |
| sale.order.line | `_set_analytic_distribution` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L1172) |
| sale.order.line | `_prepare_procurement_values` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L1183) |
| sale.order.line | `_validate_analytic_distribution` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L1190) |
| sale.order.line | `_get_downpayment_line_price_unit` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L1198) |
| sale.order.line | `_get_partner_display` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L1207) |
| sale.order.line | `_additional_name_per_id` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L1212) |
| sale.order.line | `_is_delivery` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L1220) |
| sale.order.line | `_is_not_sellable_line` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L1224) |
| sale.order.line | `_get_product_catalog_lines_data` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L1228) |
| sale.order.line | `_convert_to_sol_currency` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L1295) |
| sale.order.line | `has_valued_move_ids` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L1318) |
| sale.order.line | `_sellable_lines_domain` | unknown | [source](https://github.com/odoo/odoo/blob/bf7355f1c6a5e8929511f0aaea2ea7e5f0267b76/addons/sale/models/sale_order_line.py#L1321) |
