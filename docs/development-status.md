# Development status

## Phases (names per brief §43)

- [ ] Phase 1 — Odoo discovery (in progress: audit tooling implemented; 18 synthetic tests pass; original 96-capture audit plus a separate three-request investigation; work-order, proof approval and factory-special routes examined; findings in `docs/odoo-discovery.md` plus private reports)
- [ ] Phase 2 — Domain model (provisional foundations present: `src/core` pure domain logic, draft `schemas/*.schema.json` at `0.1.0-provisional`, synthetic `examples/**` fixtures, `tests-ts/` Node suites; specified in `docs/domain-model.md` + `docs/decisions.md`; NOT finalized — gated on Phase 1 exit criteria)
- [ ] Phase 3 — Architecture (provisional layering recorded in `docs/architecture.md`; core/viewer/packaging/platform split per brief §4; `src/core` and an internal asset/viewer harness implemented — customer packaging, platform and Tauri pending)
- [ ] Phase 4 — 3D asset prototype (partial: external GLB ingestion, provenance, validated offline inspection and two synthetic fixtures; real FlexiTog assets and Tripo comparison pending)
- [ ] Phase 5 — Product calibration (PARTIAL 2026-10-10: pure calibration/region-geometry kernel PLUS offline anchor-pick/known-distance draft panel integrated into the internal asset inspector — `pickSurface`/`setAnchorMarkers`, `src/ui/calibration`, pure `src/core/calibration-session` with 21 tests incl. restore roundtrip/forged-fit/limits, `onStateChange`→`setAsset` invalidation, pending-review session-JSON download (regions excluded) plus local restore with exact asset-hash match and recomputed unapproved fit; PLUS planar-frame draft slice: `src/core/planar-region` (18 tests) + `ModelViewer.setRegionAxes` X-red/Y-green 100 mm axes + region fieldset with probe/stale/export to a separate `0.1.0-provisional-planar-regions` bundle; PLUS safe-area draft slice: `src/core/region-areas` (22 tests: concave/exclusion/boundary/limits/precision/multi-region/determinism/stale/forged-fit/immutability) + safe/exclusion/footprint authoring with 2D SVG mm preview and dedicated deterministic `0.1.0-provisional-region-areas` export (pendingReview, never approved; null safe allowed as draft-only) plus a local same-asset area-bundle restore (`src/core/region-areas-restore`, 19 tests: exact version + asset-hash match, fit recomputed never imported, atomic calibration+regions+areas swap, 8 MiB chars / 128 regions / 512 ring vertices / 64 exclusions per region / 65536 total vertices; session path keeps its own 1 MiB limits and clears regions/areas); customer placement, curved mapping, planar-region bundle import, production integration and Windows real-asset validation pending.
- [ ] Phase 6 — Logo placement (pending)
- [ ] Phase 7 — Variant transfer (pending)
- [ ] Phase 8 — Hybrid project package (pending)
- [ ] Phase 9 — Self-contained HTML (pending)
- [ ] Phase 10 — Production export (pending)
- [ ] Phase 11 — Internal Builder (pending)

## Dependencies

Codex discovery → `docs/odoo-discovery.md` → domain schemas. Final schemas must
distinguish observed Odoo requirements from new workflow capabilities. Historical
jobs do not need to supply the coordinates that the configurator will generate.

The customer handoff now includes an editable returned project with visual
placements, mm measurements and revision-specific customer pre-approval, pending
Logo Station review. See `docs/customer-project-workflow.md`. Core revision, confirmation, internal-review and returned-data validation rules are
implemented provisionally; the editor and binary package round trip remain pending.

The internal Builder will also preview/export an operation PDF for ticket and
BoM attachments, enriching the discovered proof layouts with physical placement
details and revision/review information. See `docs/operation-pdf.md`; export and
Odoo attachment functionality are not implemented yet.

## Gaps (Phase 1 unresolved)

- Category population derived from a defined population of actual jobs.
- Operator-facing physical workflow corroboration; work orders, a routing worksheet and request/approval/production handoffs examined, but no operator screen or physical placement observed.
- Detailed tracked revisions unavailable due to upstream access denial; factory technical instructions and approval gaps remain in the private case report.

## Gaps (later phases)

- Validated product/variant calibration, placement areas and production coordinate
  conventions belong to product setup; customers need not supply them per job.
- Internal GLB viewer/ingestion present; customer packaging, platform, placement editing, PDF and Odoo integration pending.

## Implemented foundation (2026-10-10; provisional)

- TypeScript core with shared JSON Schema validation, mm placement references,
  deterministic content digests/serialization and candidate export.
- Revision-specific customer confirmation, separate internal review, preserved
  history and an issued-baseline customer-return boundary that discards returned
  internal approval. These are structured-data rules, not a browser package flow.
- Synthetic multiple-product/variant/region, repeated-logo and zero-placement
  fixtures, original SVG artwork and regression tests. Customer-specific evidence
  remains private; tracked fixtures contain no real customer data.
- Architecture and decisions document observed facts, assumptions and remaining gates.

## Remaining milestones

Schemas remain `0.1.0-provisional`; Phase 1 is not complete. Final domain/production
contracts still need evidence review. Real physical calibration and constraints,
production integration of geometry checks, variant transfer, real product assets, both offline
packaging modes, operation PDFs and internal Builder remain pending.
Internal inspector passed macOS Chrome offline `file://` checks; Windows Chrome/Edge customer delivery remains untested.

See `docs/asset-pipeline.md` and `docs/prototype-findings.md` for Phase 4 scope and verification.
