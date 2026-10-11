# Provisional domain model

Version: `0.1.0-provisional`. This foundation is not a finalized production
contract. Phase 1 exit questions remain in `odoo-discovery.md`.

## Evidence and design boundary

Observed Odoo evidence establishes finished/base-product distinctions, stock
logo components, service/cost lines that do not identify physical placements,
variant applicability, multiple-logo jobs and separate proposal/customer-approval/
production steps. Sampled proofs and worksheets do not establish calibrated
physical coordinates. The sample cannot establish population frequencies.

The project brief and `customer-project-workflow.md` require new structured
placements, customer confirmation and internal review. The following field names,
frame convention, revision protocol and fixture measurements are provisional
engineering choices, not claims about existing Odoo fields or real calibration.
Operator workflow, real calibration/constraints, non-upper-body cases, reorders,
category population and future Odoo mapping remain unresolved.

## Canonical documents

- Products contain generalized kinds, variants, regions and calibration records.
  Kinds are descriptive; no category-specific placement behavior is implemented.
- Variants list supported region IDs. Different variant calibration can be
  represented by separate regions/calibration references. A standalone draft
  transfer kernel exists; canonical project integration of transfer and placement
  overrides beyond structural/reference checks remains pending.
- Regions define a named frame/datum, axis labels, a calibration ID/version,
  safe polygon, exclusions and allowed methods. Polygon shape and references are
  checked; geometric feasibility is not yet checked.
- Logos contain portable, relative asset references with explicit roles and
  optional content hashes. Reference/proof assets are distinct from originals.
  There is no binary package loader or asset-byte verification in the core yet.
- Projects embed product/logo snapshots and selected product/variant configurations
  with 0..N placements. Artwork may recur in independent placements/regions.
  Project and per-placement instructions are preserved.
- Candidate results retain all selected configurations, including zero placements,
  product/artwork snapshots, instructions, calibration references and frame
  conventions. They always say `candidate-pending-review`.

The four checked-in JSON Schemas provide structural runtime validation using
Ajv 2020-12. Semantic checks additionally reject duplicate IDs, dangling refs,
unsupported methods/variant regions, invalid calibration refs and nonfinite data.
Unknown fields are rejected; no released legacy format or aliases exist.

## Physical convention

Positions are millimetres in the region frame, at the artwork bounding-box centre.
Synthetic frames use +x right, +y up facing the region; axes are explicitly recorded.
Width/height describe the box before rotation. Rotation is clockwise degrees
facing the region in (-180, 180]. These conventions appear explicitly in candidate
output. Mesh and pixel coordinates never enter authoritative placement data.
Real landmarks, measured calibration, surface mapping and tolerances remain future
validated product setup, not invented historical defaults.

## Revision and approval

`contentEnvelope` covers schema version, project identity, product definitions,
logo definitions/artwork references, configurations and project instructions.
`contentDigest` hashes its canonical JSON through an injected synchronous SHA-256
implementation. Revision counters, confirmation/review/history envelopes,
project-level descriptions and synthetic markers are excluded. Changing any
operational content changes the digest even if a caller forgets the revision helper.

`newRevision` clones and validates the project, increments the counter, preserves
original customer/internal approval evidence in history and clears both current
records. It rejects changed identity/version, invalid content or a manipulated
revision counter. Confirmation and internal review bind the exact revision and
content digest; their entry points reject invalid content or mismatched digests.
Customer confirmation text is unverified identity evidence, not a signature.

`importCustomerReturn` is the boundary for untrusted returns. It compares products
AND logos with a trusted internally stored issued project, validates content,
requires changed content to advance the issued revision, and rejects stale supplied
confirmation. Draft import is allowed without confirmation. It clears returned
internal review and discards returned internal history, preserving only trusted
issued history/current review as historical evidence. Import never approves.
Raw JSON validation and `hasCurrentInternalApproval` are not authentication or
trust-establishment operations; use the import boundary for customer returns.

`hasCurrentInternalApproval` checks only a valid current workflow decision/digest.
It does not establish measured calibration, safe fit, artwork suitability or
production readiness. Production exports remain a later gated milestone.

## Serialization and assets

Canonical JSON sorts object keys and object arrays where every item has a string
ID; other arrays preserve order. Special keys are retained, and lossy non-JSON or
nonfinite values are rejected. Packaging must preserve these semantics.

Synthetic SVG originals live under `examples/logos/`; asset URIs resolve relative
to `examples/`, the intended fixture-package root. Tests verify their byte hashes.
References alone do not prove offline binary round trip or artwork suitability.

## Variant transfer (provisional, standalone)

`src/core/variant-transfer` moves 0..N draft placements across explicit
source/target variant contexts without touching canonical schemas (see
`docs/variant-transfer.md`). Absolute copies mm offsets under exactly
matching declared frame conventions; normalized maps through
caller-supplied physical rects; per-placement overrides win. Context
product/variant must match same-side evidence. Output is always
pending-review with recomputed target verdicts. Inspector/UI wiring,
real calibration, production mapping, and customer packaging pending.
