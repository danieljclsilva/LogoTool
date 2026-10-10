# Calibration kernel (Phase 5 partial — kernel only)

Status: provisional utility slice. Anchor picking, interactive calibration
editor, real product calibration and production-output integration are pending.
Phase 4 real product/Tripo comparison is still pending; Phase 1 is not complete.

## What exists

- `src/core/calibration/`: pure-TS evidence validation, uniform isotropic
  least-squares scale fit (`fitUniformScale`), explicit planar frame mapping
  (`createPlanarMapping`, mm2D ↔ model3D with off-plane rejection).
- `src/core/geometry/`: pure-TS mm2D polygon validation and
  whole-footprint containment in safe-minus-exclusions.
- `examples/calibration/*.calibration.json`: synthetic generic identities for
  tee (M + XL as separate evidence), trousers, cap. All `assetFullSha256`
  values are placeholders (repeated hex characters), NOT real asset hashes; measured
  distances are invented (round 100 mm/unit scale) for kernel tests only.
- Re-exported through `src/core/index.ts`. No persistence/import contract;
  candidates are NOT integrated into the product calibration schema or
  production output yet.

## Rules

- Every fit returns `productionApproved: false, pendingReview: true`.
- One anchor pair cannot establish anisotropy, shape correctness or
  production validity. Unweighted straight-line fit only.
- Domain results MUST NEVER derive calibration from arbitrary model bounds
  or pixel size. Physical axes/plane semantics are separate from
  camera/wrapper transforms.
- Synthetic fixtures MUST NOT be presented as physically verified.


## API conventions and limits

`CalibrationEvidence` carries stable calibration/frame IDs, full asset SHA-256,
product and variant references, generic anchors and a primary measurement plus
optional extra measurements. `pairs` is the historical local name for the anchor
array; each entry is one anchor, not a measurement pair. Optional `semanticRole`
is free text; marking an anchor does not require inventing physical coordinates.
Optional anchor `physical` coordinates are informational and do not affect fitting.
Known distances must be positive straight-line millimetre spans, not surface arc
lengths or rendered pixel distances. Fixture asset hashes are explicitly fake.

Fit output retains source references, the kernel schema version
`0.1.0-provisional-calibration`, evidence revision, tolerance settings and signed
residuals. Input measurements are normalized and sorted before summation so pair
reversal/reordering preserves the whole result. Repeated measurements are included
individually, including repeats of a pair; repeats therefore affect the unweighted
fit. JSON-encoded pair IDs avoid delimiter collisions. Extremely small/large
values outside finite arithmetic range are rejected instead of exporting NaN or
Infinity. Defaults of 0.5 mm absolute tolerance and 1% relative tolerance are
prototype settings, not observed decoration tolerances; allowed residual is the
larger of those two thresholds. Consistency never establishes physical validity.

`PlanarFrameSpec` declares `frameId`, model-space origin, positive X/Y direction
vectors, positive mm per model unit and explicit off-plane tolerance in mm.
Axes are normalized; input with normalized dot product greater than 1e-6 is
rejected, and accepted near-orthogonal axes are orthogonalized for a reversible
frame. Mapping copies inputs and rejects nonfinite arithmetic outputs. Inverse
mapping returns an error beyond the declared plane tolerance. Planar mapping
cannot model a curved cap crown, sleeve or garment deformation.

Polygon utilities use `{x,y}` points in millimetres, either winding, and an
optional repeated closing point. Default epsilon is 1e-9 mm, a numerical boundary
band, not production clearance. Safe-boundary contact is allowed; exclusion
contact is rejected. Whole edges are partitioned at boundary intersections and
every intervening segment is checked, including concave voids with boundary-only
vertices. Exclusion enclosure is also rejected. Invalid rings and unsupported
finite-arithmetic ranges never pass. These checks do not establish thread/ink
clearance or fabrication feasibility and are not wired into production approval.

## Verification

Codex independently corrected boundary-only concave containment, closed-ring
handling, malformed-anchor errors, fit ordering, pair-ID collisions, numerical
range checks and near-orthogonal inverse mapping after OMP's integrated handoff.
Regression tests cover those cases as well as translated/rotated planes, multiple
scales, disagreement between measurements, safe/exclusion contact and concavity.
The existing inspector runtime is unchanged; no new browser feature is claimed.

Final checks: `npm run typecheck`, `npm test` (144 tests), and
`python3 -m unittest discover -s tests -v` (18 tests) passed. The build still
emits the offline inspector. All four revised synthetic fixtures validate and
fit their invented scale with distinct frame/variant references; no live Odoo
or external generation requests were made.
