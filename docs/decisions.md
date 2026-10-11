# Provisional decisions — 2026-10-10

## Versioned provisional contracts

Decision: use `0.1.0-provisional` and four shared JSON Schemas with strict Ajv
2020-12 runtime validation plus semantic checks.
Reason/evidence: brief §33/43 requires versioning; `odoo-discovery.md` records
unresolved operational/calibration questions.
Alternative: finalize schemas now or maintain independent hand-coded structures.
Consequence: structural contracts stay aligned; finalization remains gated.

## Physical data separate from rendering

Decision: mm positions in explicit region frames, centre reference point,
pre-rotation box dimensions, clockwise rotation; calibration ID/version is explicit.
Reason/evidence: brief §13–20 requires physical space independent of pixels/meshes;
existing proofs/worksheets do not establish actual calibration.
Alternative: persist mesh transforms or screen offsets.
Consequence: portable data is possible; the convention is provisional and real
calibration/geometry remains unverified.

## Exact operational content digest

Decision: hash schema/identity, products, logos/artwork references, configurations
and instructions, excluding revision/approval/history bookkeeping.
Reason/evidence: round-trip requirements and observed proposal size/colour changes
need confirmation tied to what the customer reviewed.
Alternative: hash placements alone or hash approval envelopes recursively.
Consequence: artwork/instruction changes stale approval; packaging must preserve
operational content. A synchronous hasher is injected; browser adaptation is future.

## Explicit import trust boundary

Decision: compare product AND logo definitions with the issued internal baseline;
clear returned internal approval, retain trusted issued review history, validate
confirmation freshness and revision progression. Draft imports remain possible.
Reason/evidence: customer pre-approval is distinct from Logo Station review in the
agreed workflow; customer-supplied definitions are not internal authority.
Alternative: treat embedded approved records as trusted.
Consequence: import never grants approval. Hashes/text identify content, not people.

## Deterministic serialization and candidate output

Decision: canonical key sorting, ID collection sorting, rejection of lossy JSON;
retain zero-placement configurations, frame/calibration/artwork context and instructions
in candidate-only output.
Reason/evidence: brief requires deterministic exports, 0..N placements and physical
production context. Independent review found placement-only digests/exports incomplete.
Alternative: persist separate edited production data or flatten away empty selections.
Consequence: one editable truth supplies derived outputs; production-ready handoff
remains deferred. Candidate format is not a final Odoo/production schema.

## Synthetic fixtures and scoped delivery

Decision: use original synthetic SVGs and invented calibration/method fixtures; defer
geometry/transfer, 3D UI, compression, HTML packaging and operation PDFs.
Reason/evidence: no validated real product calibration exists; foundation behavior can
be tested without Odoo/customer data.
Alternative: encode unverified real assumptions or claim browser delivery from a build.
Consequence: tests verify the implemented slice only; direct Windows `file://` testing
remains pending before any customer package is delivered.


## Phase 4 partial asset decisions (2026-10-10)

Use external self-contained GLB ingestion first, with a provider-neutral generator
port and deterministic synthetic assets. No Tripo credentials/uploads are implied.
Hash and preserve original bytes; all new assets start uncalibrated. The first
POSITION accessor's declared bounds are diagnostic metadata, not whole-model bounds
or physical dimensions. Require Khronos structural/binary validation in addition
to a no-external-resource policy before rendering. Use a framework-free single
HTML inspector to exercise offline memory parsing independently of the later
customer project/package flow. Windows acceptance and real asset quality stay open.

## Phase 5 partial calibration kernel (2026-10-10)

Standalone pure-TS scale/plane fitting plus mm2D polygon containment, with
synthetic tee/trousers/cap fixtures carrying separate per-variant evidence.
No persistence/import contract; not wired into product calibration records or
production output. Every fit stays candidate-pending-review and never derives
calibration from model bounds or pixels. Real measurements, anchor-picking UI
and Odoo corroboration remain pending.

## Phase 7 partial variant-transfer kernel (2026-10-11)

Provisional pure transfer of 0..N draft placements across explicit
source/target variant contexts (`src/core/variant-transfer`, 50 Node
tests). Absolute copies mm offsets under exactly matching declared
frame conventions; normalized maps through caller-supplied physical
rects (fixed-size default, opt-in proportional); per-placement
overrides win. Context product/variant labels must exactly match
same-side calibration evidence; cyclic/BigInt/NaN/Infinity inputs
fail closed without throwing or mutating. Fits recomputed in the
target, borrowed fit/frame evidence recomputed, unknown imported
approvals ignored (never applied). Output is standalone
pending-review; canonical schemas untouched. Inspector/UI wiring,
real calibration, production mapping, and customer packaging remain
pending. Assumptions explicitly provisional: normalized rotation uses
caller-declared conventions with no mirror/re-axis compensation.

Reason and evidence: brief §22/Phase 7 require multiple transfer strategies;
synthetic numerical and polygon tests verify this engineering interpretation.
This does not establish real variant dimensions or Odoo production rules.
Inferring reference rectangles from safe-area bounds or matching regions by
name was rejected because neither establishes a shared physical datum.
Consequently callers must supply explicit mappings and measured reference
rectangles; real setup and canonical project integration remain separate gates.
