# Offline testing — offline inspector and Phase 8 workflow prototypes

Maintained Playwright acceptance covers the internal asset inspector, the
transport-only package preview, the synthetic customer editor, and a separate
internal return-review harness. Hybrid ZIPs are extracted into temporary paths
with spaces and opened directly through `file://` in offline browser contexts.
The workflow specs exercise actual DOM controls and downloads, and assert zero
console/page errors and zero HTTP(S) requests.

The customer/reviewer prototype covers synthetic mm editing and local workflow
bookkeeping only. It is not real product calibration, artwork visualization,
production authorization or the Windows delivery gate.

## Requirements

- Node.js 22.18+ (repo `engines`), `npm ci` for deps.
- Browser install is setup-only (may need network); the application tests
  themselves run offline with no server or network dependency:
  `npx playwright install chromium` covers the default project.
- The e2e run rebuilds the HTML first (`npm run build`), so the tested file
  is always current.

## Commands

```sh
npm run test:e2e          # build + Playwright on bundled chromium (default gate)
npm run test:e2e:chrome   # build + real Google Chrome (channel: chrome)
npm run test:e2e:edge     # build + real Microsoft Edge (channel: msedge)
npm run test:e2e:matrix   # build + all three projects (requires Chrome AND Edge)
npm run test:e2e -- --project=chrome   # --project selection passthrough
npm run build:package-preview # transport preview + synthetic customer/reviewer artifacts
npm run build:customer-prototype # standalone inline customer/reviewer package build
```

`npm run typecheck` checks domain, viewer, and e2e/config TypeScript.
Unit/domain tests remain separate: `npm test`
(build + `node --test dist/tests-ts/*.test.js`). No live Odoo calls anywhere
in automated tests.

## Projects (`playwright.config.ts`)

No `webServer`. Three projects: `chromium` (bundled Playwright browser,
practical default), `chrome` (`channel: 'chrome'`), `msedge`
(`channel: 'msedge'`). Branded-channel launches fail clearly when the browser
is absent — missing browsers are never skipped silently. macOS runs (bundled
or installed Chrome) are development evidence only; the release gate is actual
Windows Chrome/Edge over `file://` with networking disabled, still untested.

## Suite layout (`e2e/`)

- `inspector-smoke.spec.ts` — page identity, ingest status, offline
  cleanliness, desktop + mobile layout (screenshots to ignored `test-results/`).
- `calibration-areas.spec.ts` — region/safe-area authoring, export
  determinism, forged-fit recompute, atomic failure restores, stale + camera
  stability.
- `placements.spec.ts` — 0-placement export, multi-logo/region/rotation adds,
  footprint statuses, numeric-update exact bytes.
- `placements-drag.spec.ts` — direct footprint dragging (2026-10-11, 11 tests: basic/letterbox/grab-offset deltas, rotated out-of-safe multi-step, Escape + re-drag, pointercancel/right/non-primary, real lostpointercapture + focus-loss handler + re-drag (blur fallback recorded per run), stale/restoreBusy/asset-swap invalidation, mid-drag baseline export + roundtrips, out-of-limit/tap release, quote-backslash punctuation id). Tolerance 0.05mm (0.1mm only in the 220px letterbox case); screenshots to ignored `test-results/`, attached per test+project.
- `placements-restore.spec.ts` — save/restore roundtrip incl. fresh context,
  forged recompute, atomic failures, stale lock/recovery, determinism.
- `placements-race.spec.ts` — `restoreBusy` locks and obsolete async reads
  stay inert (controlled file-read completion and state waits, no timed sleeps).
- `safe-area-regression.spec.ts` — rect + concave-with-exclusion verdicts,
  2D preview presence.
- `variant-transfer.spec.ts` — provisional transfer UI (2026-10-11, 10 tests: absolute determinism, normalized fixed/proportional worked rects, override exact mm, multi/zero/unsafe verdicts, frozen-source survives asset replacement, cross-region frozen numerics, independently calibrated variant transfer without target mutation, drag locks/cancellation, obsolete restore reads, atomic failures incl. busy-restore and rule/override invalidation). Screenshots per test+project via `test.info().outputPath`, attached per test+project.
- `project-package-inspector.spec.ts` — extracts the generated hybrid ZIP into a
  folder with spaces, opens its HTML offline through `file://`, and covers
  chooser/drop, byte-identical save/reopen, zero-placement configurations,
  oversized/failing loads and controlled obsolete reads.
- `customer-editor.spec.ts` — editable offline synthetic project ZIP workflows;
  exact detailed coverage is recorded after the acceptance run below.
- `customer-return-review.spec.ts` — selected issued/return files, trusted
  baseline comparison, exact asset-byte checks, confirmation/geometry gates,
  discarded forged reviews, atomic tamper/stale/old-revision rejection, review
  bookkeeping and revised-proposal downloads. Desktop/mobile screenshots and
  offline browser metadata are attached per test.
- `standalone.spec.ts` — asset replacement resets session/areas/placements;
  copied single HTML file (folder name with spaces, no siblings) ingests and
  runs offline. ZIP/unzip transport-preview acceptance is covered separately
  by `project-package-inspector.spec.ts`.

## Acceptance run — 2026-10-11

Independent Codex validation after OMP integration, on macOS 27.2 arm64
(Darwin 27.2.0), directly opening the built inspector through `file://`.
Contexts were offline, using 1280×900 and 390×844 viewports; every passing
test asserted zero console/page errors and zero HTTP(S) requests.

| Command | Browser | Result |
| --- | --- | --- |
| `npm run typecheck` | Domain, viewer and e2e TypeScript | Pass |
| `npm test` | Node-only domain/assets checks | 260/260 |
| `npm run test:e2e` | Bundled Playwright Chromium 156.0.8078.4 | 19/19 |
| `npm run test:e2e:chrome` | Installed Google Chrome 154.0.8037.98 | 19/19 |

The new drag cases cover live mm fields, fit feedback, fixed gesture bounds,
grab offset, rotated independent placements, cancellation and re-drag,
restore/asset invalidation, committed-only mid-drag export, deterministic
roundtrips, coordinate limits, release endpoints, and punctuation IDs.
Screenshots are saved per test/project, with desktop/mobile preview images.
The `focus-loss-evidence` attachment records whether browser focus transition
or dispatched blur exercised the handler; the final Chrome run used the
dispatched-handler path. Genuine pointer-capture loss was tested through the
browser's capture lifecycle. Native OS focus loss and touch interruptions
remain unverified.

The in-app Browser was available but refused `file://` navigation under its
URL policy. No workaround was attempted; the explicitly required repo-local
Playwright suite provided acceptance evidence. Windows Chrome/Edge, customer
ZIP delivery, real calibration and curved mapping remain separate gates.

## Variant-transfer regression acceptance — 2026-10-11

Independent Codex validation of the provisional Phase 7 pure kernel and its
integration corrections: `npm run typecheck` passed; `npm test` passed 310/310
Node tests, including 50 variant-transfer checks. No live Odoo tests were run.
At this earlier kernel-only checkpoint, the kernel was not wired into the
inspector; these runs verified the existing inspector behavior.

| Command | Environment | Result |
| --- | --- | --- |
| `npm run test:e2e` | macOS 27.2 arm64, Chromium 156.0.8078.4 | 19/19 |
| `npm run test:e2e:chrome` | macOS 27.2 arm64, Chrome 154.0.8037.98 | 19/19 |

Both final runs opened built HTML directly through `file://`, with offline
contexts at 1280×900 and 390×844. Every test checked zero console/page errors
and zero HTTP(S) requests; page identity, desktop/mobile screenshots and
placement/restore interactions remain covered. Repo-local Playwright is the
project-mandated primary acceptance route; no supplementary Browser run was
needed for this kernel/test change.

The first Chrome run failed 1/19: the existing mid-drag restore test observed
one disabled control, then the file finished restoring before its separate
export-button assertion. The test now holds `File.text` until the lock assertions
and busy-window pointer movement finish, releases the native read, then checks
that the late pointerup preserves the baseline bytes. This removes the transient
timing branch without sleeps or retries. Both complete browser suites passed
after that test-only correction. Application browser code was unchanged.
Generated reports/screenshots remain under the existing ignored paths.

Windows Chrome/Edge, actual customer ZIP delivery, real variant calibration,
curved mapping and native OS interruptions remain unverified. No Edge run was
claimed on this macOS host.

## Variant-transfer UI acceptance — 2026-10-11

Independent Codex review and validation after OMP integration of the provisional Phase 7 transfer panel
(`src/ui/variant-transfer/`, host binding in `src/ui/calibration/panel.ts`,
drag `dragActive` + start/cancel notify in
`src/ui/placement/placement-panel.ts`, fragment inlined by
`scripts/build-inspector.mjs`), on macOS 27.2 arm64. `npm run typecheck`
passed; `npm test` passed 310/310 (incl. 50 variant-transfer kernel tests).
Both browser suites below opened the built inspector through `file://` with
offline contexts (1280×900 + 390×844 per `shoot`), asserting zero
console/page errors and zero HTTP(S) requests per test.

| Command | Environment | Result |
| --- | --- | --- |
| `npm run test:e2e` | macOS 27.2 arm64, Chromium 156.0.8078.4 | 29/29 |
| `npm run test:e2e:chrome` | macOS 27.2 arm64, Chrome 154.0.8037.98 | 29/29 |

The 10 transfer tests cover absolute roundtrip determinism, normalized
fixed-size vs proportional worked rects, override exact mm, multi/zero/empty
and exclusion-unsafe (`fits:false`, still pending-review) verdicts,
frozen-source survival across asset replacement with rerun determinism,
cross-region frozen numerics (front→back verbatim), independently calibrated
SYN-V1→SYN-V2 transfer with a different mm scale and an unchanged target
draft, drag lock/cancellation recovery, obsolete-read rejection after asset
replacement, and atomic failures
(bad JSON, missing mapping, stale identity, busy restore via controlled
`File.text`, rule/override post-run edits). Screenshots use
`test.info().outputPath` per test/project (fixed-path collisions removed).
The smoke spec caught a mobile overflow from the new textareas; fixed with
transfer-scoped responsive CSS (`textarea`/`pre`/`svg`), no app logic change.
The supplementary in-app Browser was available; its attempted `file://`
navigation was rejected by its URL policy. No workaround was attempted. The
explicitly required repo-local offline suite provided acceptance evidence.
Windows Chrome/Edge delivery remains untested; no Edge run claimed.

## Failure artifacts and scope

Reports/screenshots land under the already-ignored `test-results/` and
`playwright-report/` — never committed. Only explicitly synthetic source
fixtures (`e2e/fixtures/*.json`) are tracked. Branded `msedge` requires an installed
Edge browser; no Edge run was performed for this slice. Geometry assertions go through
the UI's own verdicts/export bytes while `tests-ts/` covers the core math;
browser contexts attach OS, browser version, viewport and offline evidence to
the HTML report. Desktop/mobile screenshots use per-test/project paths and
are attached to the report.

## Phase 8 transport-preview acceptance — 2026-10-13

Independent integration validation on macOS 27.2 arm64 (Darwin 27.2.0). The
package-preview tests opened the extracted hybrid HTML through `file://` in
offline 1280×900 contexts. Each package test attaches OS/release/architecture,
browser name/version, viewport, offline state and entry point, and asserts zero
console errors, page errors and HTTP(S) requests. The pre-existing inspector
suite also exercises 1280×900 and 390×844 viewports.

Codex independently repeated typecheck, all 321 Node tests, and both full
32-test browser suites. After the final test-only download-filename correction,
Codex reran the three package tests on both browsers (6/6) and verified identical
ZIP, HTML and zero-placement fixture bytes across UTC and Amsterdam builds.

| Command | Browser / scope | Result |
| --- | --- | --- |
| `npm run typecheck` | Core, viewer and e2e TypeScript | Pass |
| `npm test` | Node-only | 321/321 |
| `npm run test:e2e` | Playwright Chromium 156.0.8078.4 | 32/32 |
| `npm run test:e2e:chrome` | Google Chrome 154.0.8037.98 | 32/32 |

The new ZIP/unzip cases cover the synthetic two-entry hybrid archive, folder
names with spaces, Choose Project and drop, byte-identical save/reopen, preserved
project and binary asset data, zero-placement and mixed configurations, failed
and oversized loads, and a controlled obsolete read. `npm run build:package-preview`
also produced identical hybrid ZIP SHA-256 output under `TZ=UTC` and
`TZ=Europe/Amsterdam`.

No Edge run was performed or claimed. Windows Chrome/Edge over `file://` with
networking disabled remains the delivery release gate and is untested. The
preview does not implement placement editing, internal baseline review, or
production export.

## Editable customer and return-review acceptance — 2026-10-14

Codex independently reviewed the OMP-integrated prototype, corrected undo history,
mobile reviewer overflow and integration typing, and completed final validation.
All fixtures and generated packages are synthetic. No live Odoo tests, external
uploads or private customer assets were used; canonical schemas remain provisional.

| Command | Environment | Result |
| --- | --- | --- |
| `npm run typecheck` | Node 26.10.0, TypeScript | Passed |
| `npm test` | Node-only | 338/338 |
| `npm run test:e2e` | macOS 27.2 arm64, Chromium 156.0.8078.4 | 41/41 |
| `npm run test:e2e:chrome` | macOS 27.2 arm64, Google Chrome 154.0.8037.98 | 41/41 |

The full suite now has 12 specs. Customer and reviewer screenshots cover
1280×900 desktop and 390×844 mobile; Codex inspected both layouts, including the
full exact-mm review and internal review controls. Pages were nonblank, correctly
identified and unobscured; document-width assertions passed. Every acceptance
context had networking disabled and asserted zero console errors, page errors
and HTTP(S) requests. The extracted customer ZIP was opened from a temporary
folder with spaces via `file://`; no web server or sibling-file fetch was used.
Environment metadata and screenshots are attached to local ignored Playwright
reports under `test-results/` and `playwright-report/`.

New coverage includes numeric placement and instruction edits in one revision,
multiple products/variants/configurations, 0..N placements, exact frame/calibration
and clockwise mm review, drag grab offsets/release/cancellation, draft and
confirmed downloads, exact original asset-byte preservation, saved confirmation
reopen, undo/reset as new revisions, oversized geometry rejection, and controlled
obsolete file/digest/save operations. The Node suite also checks combined polygon
work bounds before kernel evaluation. Reviewer acceptance covers trusted-baseline
selection, definition/artwork tampering, structurally valid digest-stale
confirmation, old revisions, forged review removal, pre-read archive bounds,
non-fitting changes-requested reviews and atomic failure preservation. A complete
DOM flow issues the generated package, edits and confirms in the customer page,
imports and reviews internally, exports a revised proposal, reopens/reconfirms in
the customer page and imports the new confirmation internally.

Rebuilding the two inline pages, issued baseline, customer ZIP and transport ZIP
under `TZ=UTC` and `TZ=Europe/Amsterdam` produced byte-identical artifacts. The
customer ZIP SHA-256 was
`958955f205f695013fb8ae60e18849f449ae98effcf8cc94b73fbe7d6b85e341`.

The in-app Browser was available, but rejected the local `file://` URL under its
HTTP(S)-only URL policy. That refusal was honored; no interactive workaround was
used. Repo-local Playwright remains the project's primary offline acceptance
mechanism. No Edge run is claimed. Actual Windows Chrome/Edge with networking
disabled remains untested. Real calibration, artwork/garment rendering, curved
surface mapping, production export and authenticated review remain outside this
synthetic prototype's evidence.
