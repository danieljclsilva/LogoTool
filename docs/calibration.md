# Calibration (Phase 5 partial — kernel + offline calibration, frames and safe areas)

Status: provisional. The kernel plus an offline anchor-picking and
known-distance draft panel are integrated into the internal
`dist/asset-inspector.html` harness. Every fit stays
`productionApproved: false, pendingReview: true`. No real product measurements
were obtained or physically validated in this development pass; production
output integration remains pending. Phase 4 real product/Tripo
comparison is still pending; Phase 1 is not complete.

## Interactive draft (2026-10-10 slices)

- `ModelViewer.pickSurface` returns mesh hits in unframed asset-scene-root
  coordinates; anchor markers share that frame and stay outside raycasts and
  framing bounds. GLB node transforms remain represented in saved coordinates.
- `src/ui/calibration/panel.ts` + `fragment.html`, with pure draft logic in
  `src/core/calibration-session/` (tested in
  `tests-ts/calibration-session.test.ts`): arm-one-shot surface picking with
  click-vs-drag (maximum pointer movement above 6px is ignored; only primary
  left-button clicks with a matching down/up sequence count), anchor list, 1..N
  known-distance measurements, `fitUniformScale`, stale-fit invalidation,
  deterministic pending-review session-JSON download
  (`0.1.0-provisional-calibration-session`; stable ordering, no timestamps),
  plus local restore of a previously downloaded session JSON.
- Restore is a local file pick only (inline `file://`, no fetch/upload): the
  current GLB must be `ready`, the file's `evidence.assetFullSha256` must equal
  the loaded asset hash exactly, and the imported `fit` block is required but
  never trusted — scale is recomputed with `fitUniformScale` and always stays
  `pendingReview`/unapproved. Pure parsing lives in
  `parseSessionRestore` (same module); the panel swaps the restored draft in
  atomically and guards in-flight reads with a sequence generation plus
  asset-record check. Obsolete read completions leave newer UI state untouched.
  Draft inputs, buttons and canvas picking are locked during reads; failed
  imports preserve the previous draft, fit and armed pick.
- `AssetInspector` exposes an optional `onStateChange` observer; `main.ts`
  routes every state into `CalibrationPanel.setAsset(record|null)` so any
  import state except `ready` wipes anchors/measurements/fit/pick/export (and
  discards in-flight restores).
## Planar frame draft

- Planar region frames (`src/core/planar-region/`, tested in `tests-ts/planar-region.test.ts`): 0..N oriented frames authored from existing anchors only — distinct origin/+X-side/+Y-side anchors, Y as the orthogonal projection of O→Y pointing toward the Y anchor (third anchor chooses the Y side; orthogonality never assumed), normal X×Y, fitted mm/unit scale, explicit nonnegative off-plane tolerance (prototype setting). Creation/export/preview require a current CONSISTENT fit; consistency never approves production. `ModelViewer.setRegionAxes` draws the active frame's X (red) / Y (green) 100 mm axes under the same asset-root wrapper, excluded from raycasts/bounds/wireframe; the panel probes existing anchors through the active frame, labels stale regions, clears regions on model replacement/reset or successful session restore, and downloads a separate deterministic `0.1.0-provisional-planar-regions` bundle (always `pendingReview: true, productionApproved: false`). The calibration session download does NOT include regions; region-bundle import is out of scope. Region frame IDs must be unique within
  a bundle. Near-collinear anchor triples with a perpendicular ratio below
  1e-6 are rejected; this is a numeric conditioning threshold, not a physical
  tolerance. UI frame values are rounded for readability; exports retain full
  numeric precision.
- Still absent in this slice: curved-surface mapping, region-bundle restore, production approval/integration, packaging claims.
## Region safe-area draft (2026-10-10 slice)

- `src/core/region-areas/` (tested in `tests-ts/region-areas.test.ts`): per-region
  nullable safe polygon + 0..N named/id exclusions in frame millimetres, bound to
  the exact frame record snapshot (`stableStringify(region)`) plus region/frame
  IDs. Pure `parsePolygonText` accepts JSON `[[x,y],...]` or `[{x,y},...]`
  (limits: 65536 chars, 3..512 vertices, 64 exclusions/region, 256-char ids/names);
  malformed/non-finite/numeric-string/self-crossing/duplicate/zero-area rings are
  rejected without partial replacement; one optional closing vertex is normalized;
  winding and full precision preserved. Validation reuses `validateSafePolygon`;
  footprint checks reuse `footprintFits`. Overlapping/outside-safe exclusions are
  retained as union obstacles (documented, no invented restrictions).
- Deterministic `0.1.0-provisional-region-areas` bundle carries the rebuilt
  planar-region bundle plus per-region area records (sorted by regionId,
  exclusions by id; deep copies; no timestamps/pixels). The provided fit is
  re-verified, never trusted; every record must match its current frame snapshot.
  `safePolygon: null` marks unconfigured frames (draft-only, not production
  readiness). Export requires a current CONSISTENT fit with all frames current.
  `pendingReview: true`, `productionApproved: false` at every level; no bundle
  import is implemented; the calibration-session importer rejects this different
  envelope version. Existing
  calibration and planar-region downloads are unchanged and exclude area data.
- `src/ui/calibration/region-areas-panel.ts` + `region-areas-fragment.html`,
  bound inside the calibration panel: active-region label + mm/frame context, safe
  textarea + Set/Clear, exclusion id/name/polygon + Add/Remove, footprint textarea
  + Check (draft geometry only), 2D SVG mm preview (viewBox from stored mm, +Y up,
  origin marker/axis legend — preview only, never backconverted), and a dedicated
  area-bundle download. Controls enable only on a current consistent fit with the
  active region matching the draft evidence and no restore in flight; verdicts
  clear on text/area/region/evidence changes; unsaved text is marked dirty.
  Removal prunes dependent areas (no inheritance on same-ID recreation); failed
  restores preserve prior frame/area state; `setAsset`/successful restore resets
  area drafts. Epsilon is numeric (1e-9 mm), not clearance.

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
- Re-exported through `src/core/index.ts`. Session restore and planar-frame
  exports have provisional envelopes;
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

Restore policy (`parseSessionRestore`, same envelope version): session JSON is
untrusted runtime data. Inputs are bounded before kernel validation — at most
1,048,576 UTF-16 code units, 512 anchors, 2048 measurements (primary + extras),
and 256 characters per free-form string (identities, anchor IDs, semantic
roles). The UI also rejects files larger than 1,048,576 bytes before reading.
Envelope version must match exactly; the `fit` block must be present
but its values are discarded and recomputed locally. Optional anchor `physical`
mm coordinates are preserved when finite, never affect the fit, and non-finite
values are rejected. Missing tolerances default to the prototype 0.5 mm / 1%
settings; missing extras restore the primary measurement only. Rebuilds are
canonical (sorted anchors/measurements, fresh copies, no input mutation).
Unknown properties are ignored; supported evidence fields are validated and copied.

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

- Safe-area browser checks passed concave edge rejection, allowed safe-boundary
  contact, forbidden exclusion contact/overlap/enclosure, independent region
  state, explicit unsaved-text notice, stale preview/export blocking, failed
  restore preservation, successful restore/replacement clearing and no area
  inheritance after same-ID region recreation. Exports retained byte-identical
  mm geometry through camera, framing and viewport changes. Desktop 1280×900
  and narrow 390×844 passed offline without HTTP(S) requests, page/console
  errors or horizontal overflow. Planar-frame and delayed-restore regressions
  also passed.
- Codex reviewed the OMP integration, removed an out-of-scope area import
  parser, and tightened frame/map bindings, prototype-like IDs, logical vertex
  limits and whitespace identity rejection. Every frame exports an explicit
  area record, including `safePolygon: null` when unconfigured.

- `npm run typecheck`, `npm test` (211 TypeScript tests, including planar-region frame/probe/bundle/stale coverage plus session
  restore roundtrip/forged-fit/limits coverage and gesture regression checks),
  and `python3 -m unittest discover -s tests -v` (18 synthetic audit tests)
  passed. The build emits one inline inspector HTML.
- Browser Use was invoked against the existing
  local `file://` inspector. It returned `net::ERR_BLOCKED_BY_ADMINISTRATOR`;
  the page could not load in that session. No upload, server or tunnel was used.
  Local Playwright 1.62.1 with installed Chrome 154.0.8037.98 on macOS then
  tested desktop 1280×900 and narrow 390×844 in an offline context. Both passed
  without horizontal overflow, HTTP(S) requests or console/page errors.
- Planar-frame browser checks restored synthetic translated/rotated/scaled
  asset-root anchors, authored two frames, probed the origin and 100 mm X anchor,
  and rejected an off-plane probe. Bundle bytes were stable through orbit,
  fit/reset, wireframe and viewport changes. Field edits immediately marked
  regions stale and disabled preview/probing/export; changing evidence back
  and refitting restored the original bytes. Duplicate IDs, blank tolerance,
  invalid triples and failed session restore preserved existing regions.
  Successful restore, anchor removal and asset replacement cleared dependent
  frames. The delayed restore-read regression also passed.
- Codex restored evidence input listeners and the pre-existing core geometry
  exports after integration, and made all region state use the live draft
  snapshot. Bundle creation now reconstructs every frame from matching source
  anchors/evidence; forged geometry, scale, references and snapshot strings are
  rejected. Core tests use genuine source evidence and cover rotated/scaled
  frames, mapping round trips, zero/nearparallel spans, overflow, off-plane
  tolerances, generic multi-region ordering, copied data and approval flags.
- Imported a synthetic GLB with translated, rotated, nonuniformly scaled nodes;
  picked two anchors and checked their inverse-transformed positions against
  the original mesh surface. Original node transforms remained represented;
  viewer framing did not enter saved coordinates. Entered 100 mm, fitted and
  downloaded a candidate bound to the exact asset SHA-256.
- Restore browser checks passed byte-identical save/load/save for current and
  inconsistent sessions, recomputation of forged scale/approval claims, preservation
  of physical anchor coordinates, malformed/version/hash/reference rejection
  without draft changes, stale edits, and replacement resets. Delayed read checks
  covered obsolete reads while a newer restore is pending, read rejection,
  canvas-pick locking and file-size rejection before reading.
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
`/tmp/logotool-*`, outside tracked source. The UI downloads a provisional
candidate and restores previously downloaded session files locally (exact asset
hash, recomputed pending-review fit). Calibration evidence and authored planar regions have separate frame IDs.
The inspector supports oriented frame and safe-area drafts; their physical
production datum still needs validation. Curved mappings remain later work.
Windows Chrome/Edge validation, real FlexiTog/Tripo assets, measured product setup,
and production readiness remain open. No live Odoo or external generation/upload
requests were made.
