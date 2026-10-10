# Calibration (Phase 5 partial — kernel + offline anchor/measure draft UI)

Status: provisional. The kernel plus an offline anchor-picking and
known-distance draft panel are integrated into the internal
`dist/asset-inspector.html` harness. Every fit stays
`productionApproved: false, pendingReview: true`. No real product measurements
were obtained or physically validated in this development pass; production
output integration remains pending. Phase 4 real product/Tripo
comparison is still pending; Phase 1 is not complete.

## Interactive draft (2026-10-10 slice)

- `ModelViewer.pickSurface(clientX, clientY)` raycasts asset meshes only and
  returns hit points in unframed asset-scene-root coordinates
  (`wrapper.worldToLocal`); `setAnchorMarkers` draws markers under the same
  wrapper so raw model coordinates align. Markers are excluded from raycast
  and fit bbox, and are cleared on model replace/clear/dispose.
- `src/ui/calibration/panel.ts` + `fragment.html`, with pure draft logic in
  `src/core/calibration-session/` (tested in
  `tests-ts/calibration-session.test.ts`): arm-one-shot surface picking with
  click-vs-drag (maximum pointer movement above 6px is ignored; only primary
  left-button clicks with a matching down/up sequence count), anchor list, 1..N
  known-distance measurements, `fitUniformScale`, stale-fit invalidation, and
  deterministic pending-review session-JSON download
  (`0.1.0-provisional-calibration-session`; stable ordering, no timestamps).
- `AssetInspector` exposes an optional `onStateChange` observer; `main.ts`
  routes every state into `CalibrationPanel.setAsset(record|null)` so any
  import state except `ready` wipes anchors/measurements/fit/pick/export.
- Still absent in this slice: candidate restore/import, region/safe-polygon
  editor, planar plane selection, production approval, packaging claims.

## Kernel utilities

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

- `npm run typecheck`, `npm test` (161 TypeScript tests, including session and
  gesture regression checks), and `python3 -m unittest discover -s tests -v`
  (18 synthetic audit tests) passed. The build emits one inline inspector HTML.
- Browser plugin not available: regular Playwright 1.62.1 used installed Chrome
  154.0.8037.98 on macOS, headless, offline context and direct `file://` opening.
  Desktop 1280×900 and narrow 390×844 views passed without horizontal overflow,
  HTTP(S) requests or console/page errors.
- Imported a synthetic GLB with translated, rotated, nonuniformly scaled nodes;
  picked two anchors and checked their inverse-transformed positions against
  the original mesh surface. Original node transforms remained represented;
  viewer framing did not enter saved coordinates. Entered 100 mm, fitted and
  downloaded a candidate bound to the exact asset SHA-256.
- Candidate bytes stayed identical through orbit, fit/reset and viewport resize.
  Field edits disabled stale export. A second 1000 mm measurement of the same
  pair produced a clearly inconsistent, pending-review export. New imports
  cleared identities, anchors, measurements, picks, markers and fit/export.
- Browser checks exercised returning orbit drags, right-clicks, cancelled and
  missed picks, invalid zero distances and cascading removal of measurements
  after anchor deletion. Unit tests cover native-event getter properties,
  multi-pointer/cancel recognition, deterministic session assembly and stale fits.

Codex independently corrected gesture recognition, explicit native event value
capture, pending-pick cancellation, blank tolerance handling and selection
preservation after OMP integration. The model raycast accepts meshes only;
markers do not participate. Prior kernel regression coverage for concavity,
exclusions, arithmetic limits, fit ordering and planar mapping still passes.

Screenshots, temporary browser checks and downloaded candidates are local under
`/tmp/logotool-*`, outside tracked source. The current UI downloads a provisional
candidate but does not restore/import it. A frame ID here identifies calibration
evidence; the UI does not select an oriented planar region or establish its
production datum/axes. Region editing and curved mappings remain later work.
Windows Chrome/Edge validation, real FlexiTog/Tripo assets, measured product setup,
and production readiness remain open. No live Odoo or external generation/upload
requests were made.
