# Development status

## Phases (names per brief §43)

- [ ] Phase 1 — Odoo discovery (in progress: audit tooling implemented; 18 synthetic tests pass; original 96-capture audit plus a separate three-request investigation; work-order, proof approval and factory-special routes examined; findings in `docs/odoo-discovery.md` plus private reports)
- [ ] Phase 2 — Domain model (round-trip workflow requirements recorded; schemas and implementation pending)
- [ ] Phase 3 — Architecture (pending)
- [ ] Phase 4 — 3D asset prototype (pending)
- [ ] Phase 5 — Product calibration (pending)
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
Logo Station review. See `docs/customer-project-workflow.md`. Requirements are
recorded; the editor, package round trip and approval behavior are not implemented.

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
- No domain, architecture, 3D, or packaging work.
