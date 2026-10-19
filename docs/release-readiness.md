# LogoTool release readiness — actionable checklist (2026-10-18)

Status key: DONE (implemented + evidenced this run) · DOABLE (engineering only,
no new evidence needed) · EVIDENCE (needs real measurements/assets/host) ·
OPERATOR (needs a human operator/pilot) · BLOCKED (needs Odoo/approval changes).

Provisional rule: everything stays `candidate-pending-review`; schemas stay
`0.1.0-provisional`. No claim below is production approval.

## A. Doable engineering (no new evidence)

- [x] DONE — Inspector→Builder planar bridge: pure conversion kernel, Builder
  import UI, verbatim evidence packaging, offline roundtrip e2e.
  Evidence: `npm test` 485/485; `e2e/prepared-product-import.spec.ts` 4/4
  Chromium; earlier three roundtrip cases also passed focused Chrome; `scripts/convert-area-bundle.mjs` CLI suite 12/12.
- [x] DONE — Operation-document package-asset previews + reference views +
  native-decode fallback + `__proto__` guards.
  Evidence: `e2e/operation-document-assets.spec.ts` 7/7 Chromium + Chrome.
- [x] DONE — Windows acceptance runner + instructions + operator pilot
  checklist. Syntax re-reviewed (no `pwsh` on the dev host — see below).
- [ ] EVIDENCE — Windows-side parse check of `scripts/run-windows-acceptance.ps1`
  (`powershell -NoProfile -Command` AST parse or PSScriptAnalyzer) and first
  real Windows run; file results per `docs/release-acceptance.md`.
- [x] DONE — Use explicit per-project Chromium/Chrome/Edge runs in the Windows runner, with separate logs/artifacts and a hard failure for missing branded browsers. `test:e2e:matrix` remains an optional combined command.
- [x] DONE — Diagnose and fix the `presentation-assets` full-suite status race.
  The source loaded and navigation hid Start; a visibility-filtered status
  locator then lost its element. Codex changed only that status assertion to
  the stable locator, preserving the subsequent navigation, content and
  roundtrip checks. No timeouts, retries or skip settings changed. Final
  independent full-suite evidence is recorded in `docs/offline-testing.md`.
- [x] DONE — Record the current suite inventory and independent results:
  23 e2e files / 131 cases; 32 Node files / 485 tests. Historical run counts
  in the acceptance log remain explicitly dated.

## B. Evidence / hardware gates (need a Windows host + real garments + measuring tools)

- [ ] EVIDENCE — Windows Chrome + Edge offline `file://` acceptance green
  (the release gate). Untested; runner + instructions ready.
- [ ] EVIDENCE — Functional Edge acceptance (the local launch check fails clearly because Edge is absent).
- [ ] EVIDENCE — Full branded-Chrome matrix green (host-instability closures
  documented; rerun evidence required).
- [ ] EVIDENCE — Real garment calibration: datum/tolerance conventions,
  physical measurement protocol corroboration.
- [ ] EVIDENCE — Curved-surface mapping (explicitly out of scope; planar-only
  bridge documents the gap) and physically mapped artwork rendering.
- [ ] EVIDENCE — Native print-dialog/printer scaling fidelity for operation
  documents (browser Print / Save as PDF path only so far).
- [ ] EVIDENCE — Artwork-format reality (real customer raster originals through
  the bounded preview path, including corrupt-input handling).

## C. Operator gates

- [ ] OPERATOR — First pilot run using `docs/operator-pilot-checklist.md`
  (preparation, calibration authoring, placement review, candidate + print,
  return handoff), with unknowns recorded and sign-off captured.
- [ ] OPERATOR — Ticket/BoM attachment workflow for candidate JSON + checked
  PDF + return project.
- [ ] OPERATOR — Office-copy retention policy (browser memory is lost on reload).

## D. Blocked on Odoo / approval

- [ ] BLOCKED — Finalized domain/production schemas (gated on Phase 1 exit).
- [ ] BLOCKED — Production-approved output requires validated physical/method
  requirements and Logo Station sign-off. Local workflow names alone do not
  establish that validation; stronger identity controls are separate scope.
- [ ] BLOCKED — Odoo attachment/mapping integration (zero live Odoo calls in
  this run; discovery docs only).

Automatic Odoo attachment is optional for the initial release: the current
handoff uses manually attached project, candidate JSON and checked PDF files.
Customer login or account setup is not a release requirement.

## Current validation snapshot (macOS Darwin 27.2.0 arm64, 2026-10-18)

- `npm run typecheck` — pass (domain + viewer + e2e).
- `npm test` — 485/485 Node, zero skipped.
- `python3 -m unittest discover -s tests` — 18/18 OK.
- `npm run test:e2e -- --workers=1` — independent Codex final run:
  131/131 Chromium 156.0.8078.4, zero retries/skips. The earlier failed
  status-visibility expectation is corrected as described above.
- Full installed Chrome 155.0.8059.80 — 128/131: two process closures with
  macOS display diagnostics and one transport timeout. A traced focused
  rerun passes all three, without source changes or retries. The full Chrome
  gate is still incomplete; the focused rerun does not replace it.
- Edge launch fails clearly because the branded browser is absent. Edge
  functional acceptance and all actual Windows runs remain untested.
- Two synthetic printed operation documents (7 and 9 pages) were rendered
  and visually inspected on every page; native printer scaling is unverified.
- No live Odoo calls, uploads, installs, publishing, commits or pushes.
