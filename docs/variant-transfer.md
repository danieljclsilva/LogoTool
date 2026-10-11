# Variant transfer (Phase 7 provisional — pending review, Phase 1 gated)

Status: provisional. This documents the pure variant-transfer kernel at
`VARIANT_TRANSFER_VERSION = "0.1.0-provisional-variant-transfer"`.
Every transfer output is a versioned **pending-review bundle**
(`pendingReview: true`, `productionApproved: false`); transfer **never
approves**. Core stays DOM/Node/Three-free; browser wiring is pending.
Full scope remains provisional pending Phase 1 exit (see
`docs/odoo-discovery.md`, `docs/development-status.md`); there is no real
calibration in this slice.

Source: brief §22 (transfer strategies: absolute offset, relative
position, proportional scaling, fixed-size logo, variant-specific
override; absolute `120 mm below collar` vs semantic-ratio resolution per
variant by real dimensions), §23 (shared topology/UV explicitly NOT
required initially), Phase 7 (absolute, normalized/proportional, variant
override); physical convention from `docs/domain-model.md` (mm in region
frame, centre reference, pre-rotation box, clockwise degrees in
(-180, 180]); pending-review/never-approves rule from `docs/decisions.md`
and `docs/calibration.md`.

## Inputs

- `VariantTransferContext { product, variant, evidence, fit, regions,
  areas, evidenceSnapshot }` for source and target: the variant's regions,
  safe/exclusion areas, calibration evidence/fit, and identity references.
- `ReferenceRect { originXmm, originYmm, widthMm, heightMm }`: a
  caller-supplied physical rectangle in frame millimetres. It is NOT
  derived from bounding boxes, geometry, pixels, or model bounds.
- `RegionTransferRule { sourceRegionId, targetRegionId,
  strategy: "absolute-position" | "normalized-position",
  sourceFrameConvention, targetFrameConvention, sourceRef?, targetRef?,
  proportionalDimensions? }`: one explicit per-region-pair mapping.
- `PlacementTransferOverride { placementId, targetRegionId, xMm, yMm,
  widthMm?, heightMm?, rotationDeg? }`: one explicit per-placement
  mapping.
- `TransferRequest { transferVersion?, source, sourceLogos,
  sourcePlacements, target, rules, overrides? }`.
- `transferPlacements(request)` is atomic: `{ ok: true, bundle }` or
  `{ ok: false, error }`. `serializeTransferBundle` is the deterministic
  serializer.

## Strategies

### absolute-position

Copies the source centre verbatim into the target region frame:

```text
xT = xS
yT = yS
wT = wS
hT = hS
```

Requires an **exact match** of declared frame conventions
(`sourceFrameConvention === targetFrameConvention`, compared as declared
strings/values — no normalization, no axis guessing). A mismatch fails
the whole transfer atomically; it is never coerced or warned through.
Rationale: brief §22 absolute rules (`120 mm below collar`) are only
meaningful under the same datum/axis convention.

### normalized-position

Maps through caller-supplied physical reference rects in frame mm.
With source rect `S = (sx, sy, sw, sh)` and target rect
`T = (tx, ty, tw, th)`:

```text
u = (xS - sx) / sw
v = (yS - sy) / sh
xT = tx + u * tw
yT = ty + v * th
```

Both `sourceRef` and `targetRef` are REQUIRED; a missing ref fails
atomically. Rects must be well-formed (finite numbers, strictly positive
width/height); malformed rects fail atomically. No ref is ever inferred
from region bboxes, safe polygons, artwork size, or strings.

Dimensions:

- Default (`proportionalDimensions` absent/false): **fixed-size** —
  `wT = wS`, `hT = hS` (brief §22 `fixed-size logo`).
- Opt-in (`proportionalDimensions: true`): **proportional scaling** —
  `wT = wS * (tw / sw)`, `hT = hS * (th / sh)` (brief §22
  `proportional scaling`).

### Worked direction (illustrative, unequal sizes + shifted origins)

Source ref `S = (0, 0, 200, 100)`, target ref `T = (10, 20, 300, 150)`,
source centre `(xS, yS) = (50, 25)`, source size `80 × 40`:

```text
u = (50 - 0) / 200 = 0.25
v = (25 - 0) / 100  = 0.25
xT = 10 + 0.25 * 300 = 85
yT = 20 + 0.25 * 150 = 57.5
fixed-size:        wT = 80, hT = 40
proportional:      wT = 80 * 300/200 = 120
                   hT = 40 * 150/100 = 60
```

## Rotation and frame conventions

- Rotation is copied unchanged (`rotationT = rotationS`), except when an
  override supplies `rotationDeg`, which then applies. Convention is the
  placement-kernel convention: clockwise degrees facing the region,
  normalized to (-180, 180] (see `src/core/logo-placements/index.ts`
  header, `docs/domain-model.md`).
- absolute-position requires exact declared convention match (above).
  normalized-position maps numbers across frames as given; it does NOT
  mirror, rotate, or re-axis frames. Mirrored/opposite-handed frames are
  an unresolved risk (see Limitations) — callers must not use
  normalized-position to paper over a handedness change.

## Override precedence

Explicit per-placement override beats any rule:

1. If `overrides[]` contains the placement id, the override applies:
   position (`xMm`, `yMm`) and target region are required from the
   override; `widthMm`/`heightMm` default to the source dims when absent;
   `rotationDeg` defaults to the source rotation when absent.
2. Otherwise the rule whose `sourceRegionId` equals the placement's
   region applies.
3. A placement with no override and no matching rule is a
   **missing-mapping** atomic failure (see Errors). There is no fallback,
   no nearest-region guess, no SKU/kind inference.

Target placement ids equal source placement ids (`idT = idS`).

## Explicit-identity requirements and prohibitions

- Every transfer is driven by explicit ids: placement ids, logo ids,
  source/target region ids in rules, override placement/target-region
  ids. No SKU inference, no product-kind inference, no string-guess
  region matching (no case/whitespace/substring heuristics).
- Reference rects are caller-supplied physical rects only. Bbox-derived
  refs (from safe polygons, exclusions, footprints, artwork pixels, model
  bounds) are prohibited.
- Source logos must exist for every transferred placement; dangling logo
  refs fail atomically.
- Context `product`/`variant` labels are bounded nonblank AND must exactly
  match the calibration evidence `product`/`variant` on the same side;
  mismatches fail atomically. Absolute-position frame conventions must be
  bounded nonblank and exactly equal (`===`, no normalization); normalized
  rotation copies the caller-declared numbers with no mirror or re-axis
  compensation.

## Currentness validation

Both contexts are validated through bundle rebuilders before any mapping:

- Source context: rebuilt via source `buildAreaBundle` (frames verified
  against source anchors/evidence, fit recomputed — never trusted).
- Target context: rebuilt via target `buildPlacementBundle`-side
  builders (frames/areas re-verified, fit recomputed).

Stale evidence, mismatched frame snapshots, inconsistent fits, or forged
imported fit values fail atomically as **stale** (same restore policy as
`src/core/region-areas-restore` and `docs/calibration.md`:
imported fits recomputed, unknown imported approvals ignored — never
applied, never claimed rejected).

## Verdict semantics

Target verdicts are **recomputed** in the target context with the reused
placement structural + footprint checks (`footprintFits` against the
target safe-minus-exclusions): safe-boundary contact allowed, any
exclusion touch/overlap fails, concave-notch escapes fail, footprints
recomputed from numbers (never carried over).

- Well-formed but geometrically unsafe transfers (outside safe,
  exclusion hit) stay in the bundle with `fits: false` plus reason —
  still `pendingReview`, never approved.
- Malformed/reference-invalid input (bad ids, dangling refs,
  nonfinite/overflow, duplicates, missing mappings, stale contexts,
  unsupported strategy/version) fails atomically with a single error and
  yields no bundle — mirroring the placement kernel's
  saveable-vs-atomic-failure split.

## Limits

Limits live in `VARIANT_TRANSFER_LIMITS` (provisional draft guards,
checked before kernel work). Pinned values in
`src/core/variant-transfer/index.ts`:

| Limit | Value |
|---|---|
| `maxPlacements` | 256 |
| `maxLogos` | 64 |
| `maxRegions` | 128 |
| `maxRules` | 128 |
| `maxOverrides` | 256 |
| `maxIdLength` | 256 chars |
| `maxDimMm` | 100000 mm |
| `maxCoordMm` | 1000000 mm |

There is no `maxChars` bound in this slice.

## Error classes

Single-string atomic failures, one per rejected transfer:

- malformed (bad ids, bad shapes, unknown fields where strict)
- nonfinite (NaN/Infinity positions, dims, rect fields, rotations)
- overflow (beyond finite-arithmetic / coord/dim bounds)
- limits (placements/logos/regions/rules/overrides/id-length exceeded)
- duplicates (placement ids, logo ids, rule pairs, override ids)
- missing-mapping (placement with no rule and no override; dangling
  logo/region ref)
- stale (source/target evidence, frames, fit, or snapshot mismatch via
  rebuilders)
- unsupported strategy (`strategy` not one of the two literals)
- unsupported version (`transferVersion` present and not the provisional
  version)

## Determinism, immutability, serialization

- Deterministic: sorted output ordering (placements/statuses by id),
  canonical JSON via the shared stable serializer; same request bytes →
  same bundle bytes. No timestamps, no randomness.
- Transfer arithmetic is physical-only (mm centres/sizes/rotations), but
  the output bundle retains model-space calibration evidence,
  region frames, and logos as provenance — copied context records,
  never derived pixel/model measurements.
- Immutable: inputs are never mutated; the bundle deep-copies
  logos/placements/statuses/contexts. Recomputed footprints and
  verdicts are fresh objects. The request passes through a safe
  data copy that preserves optional undefined fields and never invokes
  `toJSON`: cyclic, BigInt, functions, and NaN/Infinity inputs fail
  closed as `{ ok: false, error }` without throwing and without mutating
  the caller object.
- `serializeTransferBundle` rejects lossy non-JSON/nonfinite values and
  preserves full numeric precision (UI rounding, if any, never enters
  the bundle).

## Limitations + unresolved risks (explicitly NOT done)

- No real calibration: synthetic fixtures only; transfer numbers are
  draft geometry, not physically validated (Phase 1 incomplete).
- No UV/topology path: brief §23 shared-topology/UV simplification is
  explicitly deferred, never required here.
- No approvals: output is always pending-review; no customer
  confirmation, internal review, or production export is granted or
  wired.
- No browser wiring: pure kernel only; inspector/packaging integration
  pending.
- No curved-surface mapping, no deformation/anisotropy handling, no
  clearance/tolerance semantics beyond the 1e-9 mm numeric epsilon
  reused from geometry checks.
- Mirrored frames: opposite-handedness source/target conventions are not
  detected or corrected — unresolved risk; absolute-match gating and
  explicit refs are the only guards.
- Provisional version: `0.1.0-provisional-variant-transfer` is not a
  finalized contract and may change at Phase 1 exit.
