# Calibration (Phase 5 partial — kernel + offline calibration, frames and safe areas)

Status: provisional. The kernel plus an offline anchor-picking and
known-distance draft panel are integrated into the internal
`dist/dev/asset-inspector.html` harness. Every fit stays
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
  `pendingReview: true`, `productionApproved: false` at every level; local area
  restore is implemented in `src/core/region-areas-restore/` (exact bundle
  version + asset-hash match, frames/full snapshot binding re-verified through
  the builders, fit recomputed locally and never imported; 8 MiB chars, max
  128 regions, 512 ring vertices, 64 exclusions/region, 65536 total vertices).
  The calibration-session importer still rejects this different envelope
  version. Calibration and planar-region downloads remain unchanged and
  exclude area data.
- `src/ui/calibration/region-areas-panel.ts` + `region-areas-fragment.html`,
  bound inside the calibration panel: active-region label + mm/frame context, safe
  textarea + Set/Clear, exclusion id/name/polygon + Add/Remove, footprint textarea
  + Check (draft geometry only), 2D SVG mm preview (viewBox from stored mm, +Y up,
  origin marker/axis legend — preview only, never backconverted), and a dedicated
  area-bundle download. Controls enable only on a current consistent fit with the
  active region matching the draft evidence and no restore in flight; verdicts
  clear on text/area/region/evidence changes; unsaved text is marked dirty.
  Removal prunes dependent areas (no inheritance on same-ID recreation); failed
  restores preserve prior frame/area state; `setAsset` or successful session
  restore clears area drafts, while area-bundle restore replaces them. Epsilon is numeric (1e-9 mm), not clearance.

## Local area-bundle restore

- `parseAreaBundleRestore` in `src/core/region-areas-restore/` restores the
  dedicated area envelope only. It rebuilds session evidence and the fit,
  rejects inconsistent fits, verifies every planar frame against source anchors
  and evidence, and requires exactly one matching area record per region.
  Imported fit values and approval claims are discarded; all output stays
  pending review and unapproved. Null safe polygons remain unconfigured drafts.
- The host panel has a separate local area-bundle picker. Loading replaces
  calibration, frames and areas together, selects the first sorted region,
  hydrates its saved polygon, and clears pending geometry and picks. Failures
  preserve the current draft and pending text. Both restore paths share the
  busy lock and sequence/asset guards; obsolete reads cannot overwrite or
  unlock newer loads. Asset replacement clears both file pickers.
- The UI rejects files above 8 MiB before reading; the parser bounds text to
  8,388,608 UTF-16 code units, 128 regions, 512 logical vertices per ring,
  64 exclusions per region, and 65,536 total polygon vertices. Nested session
  limits remain 1 MiB, 512 anchors and 2,048 measurements. Exported drafts that
  exceed restore limits cannot be reopened through this importer.

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

## Model-only 3D setup (W3 view + lead station wiring)

Status: provisional, WIRED into the station (lead mounts
`createModelSetupView` from `src/ui/internal-builder/model-setup-view.ts` in
the model pane for model-only products; `Save 3D setup to master` commits a
calibration record, per-area projected regions and a deterministic sidecar).
A 3D model contains all viewpoints, so the model-only workflow requires NO
images: every input is an actual 3D surface pick — a raycast mesh hit in
asset coordinates through the viewer's pick API
(`pickSurface`/`pickSurfaceFromEvent`), never screen pixels and never model
bounds.

- `src/viewer/model-viewer.ts` (additive only, existing behavior preserved):
  pure `isSurfaceClick` click-vs-drag gate (≤6px, mirrors the calibration
  panel), `pickSurfaceFromEvent` convenience, `setAnchorsVisible`/
  `getAnchorsVisible` and `setSafeAreasVisible`/`getSafeAreasVisible`
  display-only toggles (staged data always kept), and a `safe-area-overlays`
  group with `setSafeAreaOverlays` (outline loop + translucent fan fill per
  named polygon). Overlays are excluded from raycasts, framing bounds and
  wireframe exactly like existing markers/axes/placements.
  `setProductVisible`/`getProductVisible` hide/show ONLY the product mesh
  subtree (flag re-applied on every model attach, so a replacement model
  cannot silently reset it); overlays, camera, framing bounds and staged
  data are untouched. The setup view exposes this as Hide/Show product and
  blocks canvas surface picking with a clear route while hidden (the
  invisible mesh must never silently accept picks); showing resumes exactly
  where staging left off.
- The view stages a two-click A/B surface reference plus a real-mm entry
  (visible endpoints, chord length, fitted scale; zero/coincident/invalid
  spans refused with actionable messages), fits ONE uniform scale through the
  real `src/core/setup-calibration/` contract (`validateReferenceSpan`,
  `fitScaleFromReferences`, `spanNativeDistance` over a single 3D span), and
  authors multiple named safe areas as 3D surface polygons (≥3 picks, no
  invented default). Each polygon derives its own region plane locally
  (`planeFromPolygon`, Newell normal + centroid origin); the polygon is
  projected onto that plane, scaled to mm under the current fit, and then
  ring-validated through the real `validateNamedSafeArea` — topology is
  kernel-checked, not reimplemented. While uncalibrated, ring checks run in
  native units and the kernel's 1e-9 numeric epsilon is unit-relative.
- Editing endpoints/mm or clearing the reference marks every dependent area
  stale; an explicit **Recompute** revalidates them under the current fit —
  never silently. Show/hide anchors + safe-areas + product and per-product
  switching are display-only and data-preserving (single-scope setups hide
  the redundant scope selector; the station-level Show product buttons
  checkbox stays separate). The standalone setup-JSON download/import and
  the raw A/B coordinate readout sit behind one collapsed **Advanced**
  disclosure (open state survives re-renders); reference/scale feedback,
  areas, toggles and the station master save (primary) stay in the normal
  flow. Save/reopen is a deterministic
  `0.1.0-provisional-model-setup` JSON envelope (asset-key bound; imported
  fit recomputed locally, never trusted; areas reopen stale). E2E is
  `e2e/setup-calibration.spec.ts` with a self-contained esbuild harness
  (`e2e/fixtures/setup-calibration-harness.ts`: real ModelViewer + view +
  synthetic cube GLB, no images).

Honest limits: straight-line chords, NOT geodesic arcs — curved-surface
mapping is out of scope. One span cannot prove shape correctness,
anisotropy or production validity. Safe-area planes assume a locally planar
patch; caps, sleeves and curved crowns are NOT modeled. Every output stays
`pendingReview: true, productionApproved: false`. No real product
measurements were taken; Windows Chrome/Edge delivery remains untested.

### Station persistence for model setup (lead)

`Save 3D setup to master` (model pane) requires a fitted, non-stale
reference and zero stale areas, then commits atomically (repackage-and-
reparse, verified): a scope-keyed calibration record
(`cal-model-<product>-<product|variant-…>`, straight-line chord wording,
never approval), ONE domain region per saved area (the area's plane-projected
ring in mm under the fitted scale — explicit planar projection via
`projectAreaToMm`, shared with the view's own check), variant linkage for the
saved model scope, and a deterministic `setup-model-sidecar/1` sidecar
carrying the verbatim view envelope (3D points, reference, areas).
Calibration, region, draft and snapshot identity are all scoped to the exact
model scope (product-wide or one variant): variant-specific models never
share drafts, snapshots, calibrations or regions, and viewer agreement
follows the same exact-or-product-wide rule (`selectPresentationModel`) — no
other variant's model is ever exposed or used. Region ids derive stably from
area ids plus scope, so re-saving updates regions in place and placements
never dangle; the stored reference span is compared, so areas-only saves
reuse the calibration version while a changed reference bumps it. Regions
whose area was deleted are removed when unplaced, retired when placed
(emptied polygon, current ref, links kept — placements preserved, geometry
gates re-verify); the save names them explicitly. Reopening the master
hydrates the view against the identical
model asset key with exact scope match (fit recomputed, areas stale); a
replaced model refuses the old setup. The customer file carries the
calibration record, projected regions and model bytes through the existing
passthrough. Multi-span consistency, curved mapping and per-variant
independent measurement remain open.

## Images two-click span calibration (lead — station primary)

Status: provisional, wired as the primary Images-path flow
(`GuidedScaleCallbacks.onSpanCommit` → `commitGuidedSpan` in
`src/ui/internal-builder/main.ts`). The operator clicks reference points A
and B on the actual photo and enters their real straight-line length
(placeholder e.g. 1300 mm); endpoints, connecting line and length stay
visible; zero/coincident/invalid spans are refused with actionable messages.
ONE span determines a uniform scale only. The mm frame convention is
operator-determined and stated everywhere: origin exactly on A, +x from A
toward B. The pure similarity (`similarityTransformFromSpan` in
`presentation-photo-mapping.ts`, tested in `tests-ts/span-similarity.test.ts`)
is rotation + uniform scale — no shear, no perspective correction. A single
span cannot solve arbitrary perspective: front-on planar photos only.

One atomic commit stores the calibration record (`cal-span-<side>[…]`,
versioned), an UNCONFIGURED region (`safeArea: []` — no safe polygon ever
invented; see the unconfigured-region rule below), the provisional similarity
mapping, and a deterministic `setup-span-sidecar/1` sidecar (verbatim W1
bundle: spans, fitted scale, no areas). The workspace seeds staging from the
saved empty polygon, so fresh calibrations start genuinely empty; the
operator draws named areas explicitly and saves once through the normal
path. Recalibrating bumps the calibration version, replaces the mapping and
explicitly clears the drawn polygon (old frame); staged drafts retire;
failures keep prior state. Photos whose mapping comes from another setup are
refused here (re-measure there, or replace the photo — replacement retires
mappings AND span sidecars naming the superseded path). The advanced
four-corner affine rectangle path is unchanged and stays available.

Rendering note (lead fix): the station stylesheet overrode first-corner
draft markers with a unit-less CSS `r: 11`, which Chromium resolves in
viewBox units — on small photos the hit area grew to ~200px and swallowed
drawing clicks (found via the shared-scope guard test, fixed fill-only).
Marker radii are now owned solely by the JS constant-pixel scaler.

### Named sibling areas (Images P1 — lead, corrected)

Every staged non-scope entry persists as its own domain region
(`<scope region id>--area-<area id>`, same frame/calibration/methods).
Identity is by STABLE AREA ID plus an explicit `activeAreaId` passed with
every save — never by polygon content or selection: the scope region always
carries exactly the scope-entry polygon (first-drawn binding; deleting the
scope entry while its region has placements is refused rather than
relocating them), so switching the staged selection or saving can never
relocate existing placements.
Identical polygons with different names are fully supported (separate
regions, separate ids, separate names). Renames, multiple polygons and the
active selection survive save/reopen deterministically (stable ids; an
explicit per-product `active-areas.json` hint records the active id per
scope, with a deterministic fallback when absent). A per-session baseline
per scope region rejects concurrent stale list replacement (another scope
saving first): the stale submitter is refused instead of silently merged,
and re-opening (Reset to saved) resynchronises. A second guard compares live
siblings against the submitter's own seed-time list (`baseNamedAreas`,
advanced on every successful save): entries live but never seen by this
bucket are refused as well. Buckets carry the explicit `activeAreaId` with
every save (unknown ids fail); deleting the scope entry while its region has
placements is refused rather than adopting a fallback polygon. Save
settlement re-baselines to the saved SCOPE polygon (never staged content),
so follow-up renders cannot misread multi-area staging as live drift.

Every region of a scope — scope plus siblings — gets its own photo mapping
(same photo/view/transform/calibration, own regionId), because the customer
binds photo preview per regionId and would otherwise fall back to a
reference-only warning for sibling areas. The staff workspace always works
through the scope region (sibling mappings never resolve as scope). Mapping
mutations are region-aware: photo replacement retires all photo-bound
mappings; span recalibration rewrites them with the new transform+version;
removal drops mappings of removed regions.

Deletion follows delete-or-retire (Codex): live regions no longer staged are
REMOVED with variant links when no placement references them (real delete —
the customer can no longer select them); REFERENCED ones are RETIRED in
place (emptied polygon so nothing new fits, current calibration ref so the
project stays valid, links kept so placed data stays resolvable while
geometry gates mark it invalid). Stale geometry is never relabelled as
current calibration output. Legacy single-area packages reopen unchanged
(scope polygon seeds one transient entry; untouched re-saves create no
siblings). Sibling regions travel to the customer file as ordinary regions,
so every named area is a real placement option there.

## Unconfigured regions (`safeArea: []`)

Status: provisional domain relaxation (lead). A calibrated region may carry
`safeArea: []`, meaning measured-but-unconfigured: the calibration and frame
exist, no safe polygon was invented, and NOTHING fits until the operator
draws it (`footprintFits` reports invalid-safe → `fits:false`; geometry
evaluation never throws; the customer diagram falls back to a neutral frame;
the operation document already marks `safeSupplied: false`). The all-or-
nothing preview-only invariant is untouched (the region, calibration and
variant linkage all exist). Drawing/authoring validation stays strict
(`validateSafeAreaPolygon`, `validateNamedSafeArea` still require ≥3-point
rings) — only the SAVED domain admits []. Exclusions keep their minimum.
`schemas/product.schema.json` and `src/core/validate.ts` changed together
(runtime Ajv contracts agree); `tests-ts/unconfigured-region.test.ts` pins
acceptance, 1/2-point rejection, invariant stability and fits:false
evaluation. Issuing a product with an unconfigured region is currently
possible without a warning (same as any undrawn setup) — recorded as a gap:
a future issue-time notice is wanted, but no silent approval exists anywhere.

## Setup-calibration kernel (`src/core/setup-calibration/`)

Status: provisional pure kernel (W1), re-exported through `src/core/index.ts`.
Unified Images/3D reference spans (2D pixel-native or 3D surface points in
one frame per call; coincident ≤1e-9 rejected; `lengthMm` > 0), single-span
exact ratio or multi-span unweighted least-squares via `fitUniformScale`
(inconsistency beyond prototype max(0.5 mm, 1%) refuses — a prototype
threshold, never a production tolerance), named safe areas (unique id,
non-blank name, valid ring, no partial acceptance), deterministic bounded
serialize/parse (sorted, stable keys, no timestamps, no approval flags at
all), and a provisional legacy-combined migrate (verbatim geometry, scale
recomputed, mixed-frame rejected). 3D distances are straight-line chords.
Tested in `tests-ts/setup-calibration.test.ts` (19 tests).

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

- Area-bundle browser checks passed byte-identical save/load/save for two
  configured frames, active-region text hydration, restored concave/exclusion
  checks, ignored forged fit/approval claims, malformed/version/hash/frame/area
  rejection with pending text and armed picks preserved, cross-mode busy locks,
  obsolete-read rejection, read failures, pre-read size rejection, and asset
  replacement during a load. Session-restore races and safe-area authoring
  regressions also passed. The same local offline Chrome environment below
  produced no console warnings/errors, page errors or HTTP(S) requests on
  desktop 1280×900 and narrow 390×844. No horizontal overflow was observed.
- Codex tested 187 malformed-data shapes without parser exceptions, reviewed
  the OMP integration fixes for the dropped component import and active-region
  hydration, and restored the original session-picker reset on asset changes.

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

- `npm run typecheck`, `npm test` (230 TypeScript tests, including planar-region frame/probe/bundle/stale coverage plus session
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

### Independent Codex closing verification — 24 October 2026

Reviewed the integrated OpenCode Contributor implementation and corrected
persistence, identity, deletion, output invalidation and 3D visibility findings
through the lead. No commits, pushes, uploads, installs or Odoo calls.

Environment: macOS 27.2 arm64; Chromium 156.0.8078.4 and installed Chrome
155.0.8059.85; Playwright 1.64.0. Repository tests open built HTML with
`file://`, networking disabled. Synthetic fixtures only. Flow viewports:
1280×900 and 390×844. The Browser plugin was absent from the actual session
tool inventory; repository Playwright was used as required by AGENTS.md.

- Independent final `npm run typecheck` and `npm test`: pass; 740 unit tests.
- Independent affected Chromium run: 17/17 pass before the final product
  visibility/Advanced change. Independent closing station-model,
  product-visibility and prepared-master tests: 3/3 Chromium + 3/3 Chrome pass
  after that change. Lead reports 18/18 affected Chrome checks pass.
- Independent preceding affected Chrome run: 16/17 pass, with a browser-process
  closure and macOS CVDisplayLink errors in the remaining master-roundtrip
  case. That case passed in the closing independent run. This does not turn
  the earlier combined run into an all-green run.
- Lead closing full Chromium run: 172 passed, 1 failed (placement restore).
  Independent isolated rerun of that existing restore case: 1/1 pass.
  Full Chrome runs likewise recorded process crashes. Broad-suite stability
  therefore remains caveated; no entirely green final matrix is claimed.
- Independent station render check: correct title and meaningful content,
  no application console/page errors or HTTP(S) requests. Inspected desktop
  and narrow screenshots of the actual model setup, including the three
  visibility buttons and collapsed Advanced controls. Test flows exercise
  reference fitting, safe areas, save/reopen, issued customer placement,
  deletion and invalidation of stale downloads.

Logs and test evidence are local under the ignored
`.opencode/setup-calibration-2026-10-24/`; additional visual captures live in
`/tmp/logotool-model-setup.png` and `/tmp/logotool-model-setup-mobile.png`.
Actual Windows Chrome/Edge offline delivery, physical measurement accuracy
and curved-surface mapping remain unverified. Calibration remains provisional.
