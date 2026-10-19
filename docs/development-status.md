# Development status

## Phases (names per brief §43)

- [ ] Phase 1 — Odoo discovery (in progress: audit tooling implemented; 18 synthetic tests pass; original 96-capture audit plus a separate three-request investigation; work-order, proof approval and factory-special routes examined; findings in `docs/odoo-discovery.md` plus private reports)
- [ ] Phase 2 — Domain model (provisional foundations present: `src/core` pure domain logic, draft `schemas/*.schema.json` at `0.1.0-provisional`, synthetic `examples/**` fixtures, `tests-ts/` Node suites; specified in `docs/domain-model.md` + `docs/decisions.md`; NOT finalized — gated on Phase 1 exit criteria)
- [ ] Phase 3 — Architecture (provisional layering recorded in `docs/architecture.md`; core/viewer/packaging/platform split per brief §4; `src/core` and internal inspector harness implemented — production package delivery, platform and Tauri pending; synthetic customer editor implemented)
- [ ] Phase 4 — 3D asset prototype (partial: external GLB ingestion, provenance, validated offline inspection and two synthetic fixtures; real FlexiTog assets and Tripo comparison pending)
- [ ] Phase 5 — Product calibration (PARTIAL 2026-10-10: pure calibration/region-geometry kernel PLUS offline anchor-pick/known-distance draft panel integrated into the internal asset inspector — `pickSurface`/`setAnchorMarkers`, `src/ui/calibration`, pure `src/core/calibration-session` with 21 tests incl. restore roundtrip/forged-fit/limits, `onStateChange`→`setAsset` invalidation, pending-review session-JSON download (regions excluded) plus local restore with exact asset-hash match and recomputed unapproved fit; PLUS planar-frame draft slice: `src/core/planar-region` (18 tests) + `ModelViewer.setRegionAxes` X-red/Y-green 100 mm axes + region fieldset with probe/stale/export to a separate `0.1.0-provisional-planar-regions` bundle; PLUS safe-area draft slice: `src/core/region-areas` (22 tests: concave/exclusion/boundary/limits/precision/multi-region/determinism/stale/forged-fit/immutability) + safe/exclusion/footprint authoring with 2D SVG mm preview and dedicated deterministic `0.1.0-provisional-region-areas` export (pendingReview, never approved; null safe allowed as draft-only) plus a local same-asset area-bundle restore (`src/core/region-areas-restore`, 19 tests: exact version + asset-hash match, fit recomputed never imported, atomic calibration+regions+areas swap, 8 MiB chars / 128 regions / 512 ring vertices / 64 exclusions per region / 65536 total vertices; session path keeps its own 1 MiB limits and clears regions/areas); customer placement, curved mapping, planar-region bundle import, production integration and Windows real-asset validation pending.
- [ ] Phase 6 — Logo placement (PARTIAL 2026-10-11: first planar draft slice implemented in `src/core/logo-placements` and `src/core/logo-placement-restore`. Supports 0..N placements referencing independent synthetic logos and calibrated regions, centre x/y and width/height in mm, clockwise rotation, and recomputed footprint checks against concave safe polygons and exclusions. Inspector includes numeric editing, per-placement verdicts, 2D mm previews, and distinct asymmetric synthetic artwork in 3D mapped from the same physical corners. Versioned deterministic draft export/atomic restore requires the exact asset hash and recomputes fit, frames and verdicts; imported approvals never apply. 30 placement tests + 11 restore tests; offline macOS Chrome `file://` round trips, existing area/session regressions, and delayed placement-restore locks/obsolete-read checks pass with no console errors or HTTP requests. Repeatable offline checks are maintained in `e2e/`; generated reports remain local and ignored (see `docs/offline-testing.md`). Curved mapping, real calibration, production approval, customer packaging and Windows Chrome/Edge verification remain separate; domain/production schemas are not finalized.)

  Direct 2D dragging added in the internal inspector (2026-10-11): primary-pointer movement preserves grab offset, dimensions, rotation and references; a fixed gesture viewBox converts pointer coordinates into region millimetres. Numeric fields, verdicts and 3D overlays show the candidate, while exports retain committed bytes until release. Core limits gate movement and release; stale context, restore, asset replacement and cancellation discard the candidate. The maintained drag spec adds 11 offline tests, including release endpoints, punctuation IDs and save/restore. Windows delivery, curved mapping and production approval remain pending.

- [ ] Phase 7 — Variant transfer (PARTIAL 2026-10-11: provisional pure kernel `src/core/variant-transfer` with 50 Node tests — absolute/normalized/proportional/override, rotation copy, 0..N/multi-region, stale/forged currentness, concave/exclusion verdicts, determinism/immutability, malformed/limits; standalone pending-review contracts, canonical schemas untouched. PLUS offline inspector panel `src/ui/variant-transfer` (2026-10-11): frozen source capture via `buildPlacementBundle`, explicit current-target context incl. committed draft in the result signature, operator-declared rules starting `[]` with illustrative +Y-up examples, atomic draft run with full-precision numbers and read-only preview, deterministic pending-review export; 10 Playwright tests in `e2e/variant-transfer.spec.ts` covering absolute/normalized/override, multi/zero/unsafe, source-survives-replacement, cross-region and independently calibrated variant transfer, unchanged target drafts, drag locks/cancellation, obsolete reads, and atomic/busy/invalidation flows. Real calibration, production mapping, and customer packaging still pending.)
- [ ] Phase 8 — Hybrid project package (PARTIAL 2026-10-14: deterministic `.logo-project` transport plus a synthetic offline planar customer editor and separate baseline-based return reviewer. Integrated Node and offline DOM verification is recorded below; the Windows release gate remains pending. Real calibration/artwork mapping, production-ready export and finalized schemas are out of scope; see `docs/project-packaging.md`.)
- [ ] Phase 9 — Self-contained HTML (PARTIAL 2026-10-14: reusable browser-independent `src/packaging/self-contained-html` module embeds the same binary `.logo-project` into a single HTML file; the customer editor auto-loads the embedded package on startup through the same atomic parse pipeline, preserves Choose Project/drop, and exports the identical editable `.logo-project` return. Node tests cover determinism, round-trip, size limits, and injection resistance; a new Playwright spec exercises auto-load, edit/confirm/save/reopen, zero-placement, malformed embedded data, obsolete-startup replacement, and desktop/mobile viewports. The Windows `file://` release gate remains untested.)
- [ ] Phase 10 — Production export (PARTIAL 2026-10-15: internal return reviewer shows an operational candidate preview and downloads deterministic JSON through the existing `buildCandidateExport`/`serializeExport` contract. A browser-printable pending-review operation-document preview now derives from the same canonical snapshot, includes project/revision/digest, all configurations including zero placements, consistent placement numbering, exact unrounded mm dimensions/centre/rotation, frame axes/origin, calibration identity/version, artwork asset references as inert text, method and project/placement instructions, and dimensioned planar SVG positioning diagrams with safe polygons/exclusions and rotated bbox footprints. Status is always `candidate-pending-review`, including after internal workflow approval. Canonical schemas remain provisional; production-ready PDF output, real artwork/product rendering and Odoo attachment remain pending.)
- [ ] Phase 11 — Internal Builder (PARTIAL 2026-10-15: local validated source selection of products/variants/artwork, clean revision-1 issues with explicit identity, both delivery formats, deterministic bytes and exact saved-baseline restoration, return comparison, candidate JSON and operation-document Print / Save as PDF. Separate full reviewer downloadable for decisions/reproposal. Synthetic calibration and Windows release gates remain pending; see `docs/internal-builder.md`.)

## Phase 11 — Internal Builder (Codex-validated 2026-10-15)

The pure `src/core/project-builder` kernel selects source snapshots and creates
clean revision-1 issues with explicit project identity; missing default variant
configurations start empty. `src/ui/internal-builder` builds to
`dist/internal-builder.html`, with the inline customer editor and full reviewer
embedded once. It generates both formats, saves/restores exact issued baselines,
compares returns and prepares pending candidate JSON/operation-document handoff.
Usage and limits are in `docs/internal-builder.md`.

Independent validation: typecheck passed; 379/379 Node tests; full offline
Chromium suite 70/70; final focused Builder 10/10 in Chromium and 10/10 in
installed Chrome. See `docs/offline-testing.md` for versions, viewports and scope.
Windows delivery and the existing full Chrome gate remain unresolved.

## Jacket validation snapshot — 2026-10-15

Per the user's latest direction, Windows validation is deferred. The retained
private jacket development model has been tested using an explicitly synthetic
scale (user-authorized), with no claim of measured garment dimensions or
production approval. The inspector/placement draft and the
Builder/customer package were separate flows at that date. The 2026-10-18
planar conversion/import bridge now connects authored inspector area bundles
to customer projects; it does not establish physically mapped jacket artwork
or real garment calibration. See the jacket test-model acceptance record in
`docs/offline-testing.md` before treating package tests as model-based acceptance.

## Dependencies

Codex discovery → `docs/odoo-discovery.md` → domain schemas. Final schemas must
distinguish observed Odoo requirements from new workflow capabilities. Historical
jobs do not need to supply the coordinates that the configurator will generate.

The customer handoff target remains an editable returned project with physical
measurements and revision-specific pre-approval, pending Logo Station review. A
synthetic offline planar editor and local baseline reviewer now exercise the
workflow; the browser bridge to async Web Crypto keeps the core's sync digest
contract strict. All schemas and workflow rules remain provisional. See
`docs/customer-project-workflow.md`.

The Internal Builder previews operation documents with browser Print / Save as PDF
and prepares ticket/BoM attachment details. Direct production PDF generation and
Odoo attachment functionality remain pending. See `docs/operation-pdf.md`.

## Gaps (Phase 1 unresolved)

- Category population derived from a defined population of actual jobs.
- Operator-facing physical workflow corroboration; work orders, a routing worksheet and request/approval/production handoffs examined, but no operator screen or physical placement observed.
- Detailed tracked revisions unavailable due to upstream access denial; factory technical instructions and approval gaps remain in the private case report.

## Gaps (later phases)

- Real product/variant calibration, safe-area constraints and production
  coordinate conventions remain unvalidated. Synthetic fixture measurements are
  not FlexiTog product data.
- The synthetic editor uses inert labelled footprint boxes rather than original
  artwork or 3D/curved mapping. Production-ready output/PDF, platform adapters and Odoo
  writes remain pending.

## Implemented foundation (2026-10-10; provisional)

- TypeScript core with shared JSON Schema validation, mm placement references,
  deterministic content digests/serialization and candidate export.
- Revision-specific customer confirmation, separate internal review, preserved
  history and an issued-baseline customer-return boundary discard returned
  internal approval. The offline customer editor and reviewer now exercise these
  provisional APIs while keeping local names/decisions unauthenticated.
- Synthetic multiple-product/variant/region, repeated-logo and zero-placement
  fixtures, original SVG artwork and regression tests. Customer-specific evidence
  remains private; tracked fixtures contain no real customer data.
- Architecture and decisions document observed facts, assumptions and remaining gates.

## Remaining milestones

Schemas remain `0.1.0-provisional`; Phase 1 is not complete. Final domain and
production contracts still need evidence review. Real physical calibration,
curved mapping, production-ready export/PDF and authenticated review remain pending.
The Internal Builder is a provisional local-source prototype. Hybrid and self-contained editors/reviewer are only
a synthetic workflow prototype; Windows Chrome/Edge delivery remains unverified.
Suite inventory 2026-10-18: 23 e2e spec files (131 cases), 32 Node test files
(485 tests). Codex independent validation: typecheck passes, 485/485 Node,
18/18 Python, and 131/131 offline Chromium (`--workers=1`, no retries/skips).
The earlier Chromium failure was traced to a visibility-filtered status
expectation after successful navigation, and that assertion is corrected.
The acceptance log records the installed-Chrome result and the explicit Edge,
Windows and physical-validation gaps. See `docs/offline-testing.md`.

See `docs/asset-pipeline.md` and `docs/prototype-findings.md` for Phase 4 scope and verification.
