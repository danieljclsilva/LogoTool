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
- `self-contained-customer.spec.ts` — copies only the issued HTML to an empty
  temporary folder with spaces, auto-loads the exact hybrid issued bytes, saves
  and reopens edits/confirmation, imports the return in the reviewer, covers
  zero placements, malformed/duplicate/oversized embedded data and chooser
  recovery, and deterministically releases an obsolete startup digest after
  replacement. Desktop/mobile screenshots and environment metadata are attached.
- `operational-candidate-preview.spec.ts` — baseline-based internal reviewer candidate preview/download, canonical byte agreement, zero/repeated placements, approval-independent pending status, failed-load preservation, revised proposal refresh, inert instruction text, controlled obsolete hashing and hash-failure recovery. Desktop/mobile screenshots and offline environment metadata are attached.
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


## Self-contained issued HTML acceptance — 2026-10-14

The OMP lead reached its 30-minute deadline before returning an integration
report. Codex independently reviewed the working tree, restored the file loader's
pre-read archive bound and generation/lock/error handling, and replaced the
unbounded duplicated decoder with shared strict bounded base64 decoding. Codex
also removed the browser-global test entry point and expanded acceptance to exact
asset bytes, reviewer import, oversized/duplicate data recovery, viewport bounds,
environment attachments and controlled completion without a timed sleep.

| Command | Environment | Result |
| --- | --- | --- |
| `npm run typecheck` | Node 26.10.0, TypeScript | Passed |
| `npm test` | Node-only | 355/355 |
| `npm run test:e2e` | macOS 27.2 arm64 (Darwin 27.2.0), Chromium 156.0.8078.4 | 47/47 |
| `npm run test:e2e:chrome` | Same OS, installed Chrome 154.0.8037.98 | 47/47 |

The 13-spec suite includes all hybrid/inspector regressions. Standalone tests open
one copied HTML file with no siblings through `file://` in offline contexts,
with 1280×900 and 390×844 layout evidence. Codex inspected the final Chrome
screenshots: project identity, measured footprints, exact-mm review and controls
are visible and unobscured; horizontal-width assertions pass at both sizes. Every
browser test checks zero console/page errors and zero HTTP(S) requests. The pure
packaging-boundary e2e case does not launch a browser; its byte-limit checks are
also covered in Node tests. Reports and generated artifacts remain local under
already ignored paths. No live Odoo calls, external uploads or customer data
were used; no schema was finalized.

New coverage compares embedded bytes with the hybrid's separately emitted issued
baseline, checks complete saved project/assets against that baseline, edits and
confirms revision 2, reopens its saved return and imports it into the separate
reviewer with current confirmation and valid geometry. Zero-placement packages
load independently. Invalid base64, invalid archives, duplicate blocks and a
payload above the 64 MiB encoded ceiling fail and then accept a chosen valid
package. The race test holds the last startup asset digest, installs a different
project through drop, releases the obsolete digest and waits for its completion;
the chosen project remains installed. Node tests include noncanonical padding,
HTML termination strings, encoder chunk boundaries and size rejection.

Rebuilding under `TZ=UTC` and `TZ=Europe/Amsterdam` produced identical bytes for
self-contained HTML, customer/reviewer HTML, issued baseline and both ZIPs.
The generated self-contained file is 249,904 bytes; the hybrid editor is 247,200
bytes and the issued project is 1,992 bytes. The base64 payload is 2,656 bytes
(33⅓% above the archive), and replacing the marker increases HTML by 2,704 bytes.
The self-contained SHA-256 is
`3d0268b1d40c3adad6df50d3081794663c6556dbd538c0e3fa852900bc010f3b`.

This is synthetic provisional Phase 9 evidence. Windows Chrome/Edge offline
`file://` remains an untested release gate, and no Edge run is claimed. Real
calibration/artwork/curved mapping, production output/PDF and authenticated review
remain pending. Repo-local Playwright provided the required acceptance; no
supplementary Browser inspection was performed in this run.


## Operational candidate preview/export acceptance — 2026-10-14

The OMP run ended at its 20-minute limit with UI and test changes but no
integration report. Codex independently reviewed them, removed redundant async
preview hashing, made preview ordering follow canonical export bytes, guarded
obsolete download errors/status and busy operations, and added revision, inert
text and controlled export-race/recovery coverage. No canonical schema or core
export contract changed. No Odoo calls, uploads, commits or pushes were made.

The flow under test is: select a locally held issued baseline and customer
return → import through the existing trust boundary → inspect physical candidate
data → download canonical JSON → revise instructions/measurements → verify the
preview and saved project/export agree at the new revision. Candidate status is
always `candidate-pending-review`, including after workflow approval.

| Command | Environment | Result |
| --- | --- | --- |
| `npm run typecheck` | Node 26.10.0 / TypeScript | Passed |
| `npm test` | Node-only | 355/355 |
| `npm run test:e2e` | macOS 27.2 arm64, Chromium 156.0.8078.4 | 55/55 |
| `npm run test:e2e:chrome` | Same OS, Chrome 154.0.8037.98 | 52/55; browser closed during three existing variant-transfer cases |
| `npm run test:e2e:chrome -- --workers=2` | Same installed Chrome | 54/55; browser closed during teardown of existing transfer-atomic-failures case |

All eight new candidate cases passed on both Chrome runs and in Chromium.
Failures reported closed page/context/browser, with macOS
`CVDisplayLinkCreateWithCGDisplay` and GPU mailbox diagnostics in browser-process
logs. The second failure was at `context.close()` after the transfer case's
assertions. This is evidence of browser/host instability, not proof of its root
cause; the full Chrome gate remains failing. No assertion was removed, no test
skipped, and no browser launch flags or application changes masked these failures.
Initial Chrome report was preserved locally at
`/tmp/logotool-chrome-initial-report`; the latest report remains under ignored
`playwright-report/` and `test-results/`.

Acceptance contexts opened built `dist/customer-return-review.html` directly
through `file://`, offline, at 1280×900 and 390×844. They attach OS/release/arch,
project/browser version, viewport, entry point and offline state. Every new case
asserts zero console/page errors and zero HTTP(S) requests. Existing extracted
hybrid and standalone package tests remain in the full regression runs.

The eight candidate tests cover canonical byte agreement with the existing core
export, all physical values and conventions, multiple/repeated artwork and zero
placements, independent internal approval/pending candidate status, failed-load
preservation, absent-pair clearing, exact revision refresh after a numeric and
instruction proposal (also checking the binary saved project), inert HTML-like
instructions, controlled obsolete hashing without download/status mutation, and
hash-failure unlock/retry. The preview uses `textContent` and preserves instruction
line breaks; artwork references are displayed as text, not fetched or rendered.

Codex inspected desktop/mobile summary and desktop measurement screenshots: the
page is identified and nonblank, there is no framework error overlay, text is
readable and unobscured, and the mobile width assertion passes. Screenshot
attachments are `candidate-desktop`, `candidate-desktop-measurements` and
`candidate-mobile`; inspected Chrome copies are also local at
`/tmp/logotool-candidate-desktop.png`,
`/tmp/logotool-candidate-desktop-measurements.png` and
`/tmp/logotool-candidate-mobile.png`.

The supplementary in-app Browser was available but rejected the local URL:
its URL policy allows only HTTP(S). That refusal was honored without a
workaround; the explicitly required repo-local Playwright suite remains the
primary offline acceptance route. Windows Chrome/Edge and real calibration
remain untested. This slice is a provisional operational candidate preview/JSON
export; production-ready output, operation PDFs, artwork/product rendering and
final Odoo mapping remain pending.

## Operation-document preview/print acceptance — 2026-10-15

OMP delivered the bounded operation-document view model, DOM/SVG renderer and
reviewer integration. Codex independently reviewed and corrected physical Y-up
rendering (clockwise rotation), the actual frame datum, diagram bounds including
exclusions/axes, label/value grouping, frame ID and rotation convention,
confirmation/review notes and timestamps, long-instruction pagination, and print
identity/status/page footers. The existing candidate JSON slice was preserved.
Canonical schemas and the core candidate export contract remain unchanged.

The flow under test is: select a separate issued baseline and return → compare
against that baseline → inspect the operation document from the canonical
candidate snapshot → revise physical values/instructions or record a review →
verify the refreshed document and JSON agree → invoke browser printing. This is
browser Print / Save as PDF, not a direct PDF download or production release.

| Check | Environment | Result |
| --- | --- | --- |
| `npm run typecheck` | Node 26.10.0, macOS 27.2 arm64 | Passed |
| `npm test` | Node-only; build first | 363/363 passed |
| `npm run test:e2e` | Chromium 156.0.8078.4 | 60/60 passed |
| `npm run test:e2e:chrome -- e2e/operation-document-preview.spec.ts e2e/operational-candidate-preview.spec.ts` | Installed Chrome 154.0.8037.98 | 13/13 passed |
| Final `npx playwright test --project=chromium e2e/operation-document-preview.spec.ts` | Built final print layout, same Chromium | 5/5 passed |
| Final `npx playwright test --project=chrome e2e/operation-document-preview.spec.ts` | Built final print layout, same installed Chrome | 5/5 passed |
| Browser PDF capture and Poppler rendering | Chromium, A4, offline | All 6 normal and 9 long-instruction pages visually inspected |

Every acceptance context opens built `dist/customer-return-review.html` through
`file://` with networking disabled. Desktop 1280×900 and mobile 390×844 are
covered. The operation spec attaches actual OS/release/architecture, browser
version/project, viewport, offline state and entry point; it asserts zero console
errors, page errors and HTTP(S) requests. It covers exact values and candidate
identity, physical SVG orientation, explicit zero placements, print-media hiding
of reviewer controls, revision refresh with decimal measurements and inert
HTML-like instructions, mobile width, print-button invocation, review notes,
and clearing the document/print control when a fresh page has no valid pair.
The Node tests also check clockwise rotated corners, true datum, bounds including
an outlying exclusion and deterministic, non-mutating view-model construction.

Codex additionally generated two synthetic PDFs through Playwright's browser
print engine, rendered every page with `pdftoppm`, and inspected desktop/mobile
screenshots and every PDF page for readability, clipping, overlap and diagram
orientation. Page/revision/pending status and page counts were verified on every
page with `pypdf`. The long case preserves all 85 numbered project-instruction
lines and 45 numbered placement notes. PDF text extraction supplements visual
review; it is not the sole layout evidence. The print identity is CSS-string
escaped and kept in the head stylesheet; controls and unrelated reviewer content
are excluded by print CSS. Configuration details may span several pages.

Local reproducible QA script and evidence are under
`/tmp/logotool-operation-review.t7DUf2/`: `visual-qa.mjs`,
`visual-environment.json`, `operation-review.pdf`, `operation-review-long.pdf`,
`head-normal-*.png`, `head-long-*.png`, `document-desktop.png`,
`document-mobile.png` and `final-*.log`. These are temporary development evidence,
not tracked deliverables. The maintained test sources are in `tests-ts/` and
`e2e/`. No extra runtime dependency was added.

The supplementary in-app Browser was available but rejected `file://` because
its URL policy permits HTTP(S) only. The refusal was honored. The separately
required repo-local Playwright offline suite supplied acceptance evidence, as
specified by AGENTS.md; no server or Browser-policy workaround was introduced.

Remaining gaps: native OS print-dialog choices/printer scaling, actual Windows
Chrome/Edge `file://` delivery, real calibration and garment/artwork rendering,
authenticated review, finalized Odoo mapping and direct production PDFs. The
prior full-suite Chrome failures remain documented above; this focused run does
not replace that full gate. No Edge acceptance is claimed. No Odoo calls, uploads,
commits or pushes were made. Documents always remain `candidate-pending-review`.

## Internal Builder acceptance — Phase 11 (2026-10-15)

OMP (Muse Spark 1.3 Contributor) delivered the initial kernel/UI/test slices.
Codex independently reviewed and corrected read-before-limit handling, obsolete
operation cancellation, stale downloads after edits, explicit per-issue project
identity, zero artwork, saved-baseline restoration and context switching,
missing-variant empty configurations, print identity, asset/ID lookups,
Windows-portable generated filenames and mobile summary wrapping. The OMP
correction pass hit its time limit without an integrated report; these final
results are Codex validation of the resulting working tree.

The flow under test is: select local source/products/variants/artwork → issue
both formats → open extracted hybrid or standalone HTML offline → edit/confirm
and save a return → reopen a saved issued baseline in a fresh Builder page →
compare return → download candidate/preview operation document → open the
separate downloaded full reviewer.

| Command | Scope/environment | Result |
| --- | --- | --- |
| `npm run typecheck` | Domain, browser and e2e TypeScript | Pass |
| `npm test` | Node-only, build first | 379/379 (16 Builder checks) |
| `npm run test:e2e` | Full suite, Chromium 156.0.8078.4 | 70/70 |
| `npx playwright test --project=chromium e2e/internal-builder.spec.ts` | Final Builder including filename/status adjustments | 10/10 |
| `npx playwright test --project=chrome e2e/internal-builder.spec.ts` | Final Builder, installed Chrome 154.0.8037.98 | 10/10 |

OS: macOS 27.2 arm64, build 26B5112a. Entry points are built
`dist/internal-builder.html`, extracted generated hybrid HTML, standalone
self-contained HTML and downloaded full reviewer, all directly over `file://`
with networking disabled. Viewports: 1280×900 and 390×844. Every Builder case
asserts zero console/page errors and zero HTTP(S) requests, including new pages.
The spec attaches actual OS/browser/version/viewport/offline metadata. No server,
live Odoo calls, customer data or external runtime dependency is used.

The ten cases cover selection rendering; asset-pruned hybrid generation and
actual offline editing/saving; standalone self-contained loading; zero logos
and zero placements; invalid source preservation; source replacement clearing;
exact baseline bytes, edited/confirmed return, fresh-page baseline recovery,
explicit saved-baseline switching, wrong-issue rejection preserving prior valid
review, candidate/operation revision agreement and full reviewer loading;
selection/identity/format invalidation and deterministic HTML/ZIP regeneration;
pre-read size rejection, caught read failure, controlled obsolete read completion
and a no-artwork source; and controlled pending generation cancellation,
input locks, hash failure and retry. Controlled races use released promises and
state checks, never timed sleeps. A reserved Windows job name (`CON`) produces
portable `_CON` filenames. Candidate JSON always remains pending review.

Codex inspected desktop/mobile generated-issue and restored-return screenshots.
Pages are identified, nonblank, readable and free of framework overlays; controls
and measured diagrams render, and mobile horizontal-width assertions pass.
Print media hides Builder controls, exposes the operation document and uses the
returned candidate's revision in the footer. Native print dialogs and actual
printer scaling were not tested. Shared operation-document PDF layout evidence
is recorded in the previous section; no new production-PDF claim is made here.
Screenshots remain in ignored per-test `test-results/` paths; inspected viewport
crops are `/tmp/logotool-phase11-desktop.png`,
`/tmp/logotool-phase11-mobile.png` and `/tmp/logotool-phase11-return-mobile.png`.
The final inline Builder is 927,110 bytes, including inert editor/reviewer HTML.

The supplementary in-app Browser capability was verified, but its URL policy
rejected `file://`. That refusal was honored. The independently required
repo-local Playwright suite supplied acceptance; no server, indirect navigation
or Browser-policy workaround was used.

Remaining gates: actual Windows Chrome/Edge offline delivery, real calibration
and artwork/garment rendering, authenticated review, finalized domain/production
schemas and Odoo attachment integration. No Edge acceptance is claimed.
The prior full-suite Chrome failure remains documented: this focused Chrome
result does not replace the full Chrome gate. No commits or pushes were made.

## Private jacket test-model acceptance — 2026-10-15

Windows validation is deferred at the user's request. The user selected the
retained private jacket test asset and explicitly approved a clearly labelled
synthetic scale for this development run. This is a one-off local test-model
assessment, separate from the synthetic-only maintained regression suite.
Original model/source/provenance bytes were preserved; no uploads or provider
calls were made. No production dimensions or approvals are inferred.

Environment: macOS 27.2 arm64 (Darwin 27.2.0), Chromium 156.0.8078.4 and installed
Chrome 154.0.8037.98. Repo-local Playwright opened built
`dist/asset-inspector.html` directly through `file://`, offline, at 1280×900 and
390×844. Both runs recorded zero console/page errors and HTTP(S) requests.

| Check | Chromium | Chrome |
| --- | --- | --- |
| Original hash matches retained manifest; self-contained ingestion/validator | Pass | Pass |
| Textured model visible; orbit/fit/reset/wireframe controls | Pass | Pass |
| Original GLB download preserves exact bytes; provenance remains uncalibrated | Pass | Pass |
| Three surface-picked anchors and synthetic scale fit | Pass | Pass |
| Planar region, two distinct logos, numeric footprints and synthetic obstacle rejection | Pass | Pass |
| Camera changes preserve exported bytes; fresh-page reload/restore is byte-identical | Pass | Pass |
| Desktop/mobile content/layout; no horizontal overflow | Pass | Pass |
| Logos visibly conform to the jacket's curved surface | Not established; expected logos not visible in inspected default view | Same |
| Builder → customer model/placement package → return | Not implemented | Not implemented |

Scale evidence: A→B is assigned **100 mm solely for testing**, yielding
291.93177248010517 mm per model unit. Product/variant/calibration/anchor labels
explicitly identify synthetic evidence. The arbitrary planar 100×100 mm area
and square exclusion are test inputs, not observed garment constraints. Two
placements (30×15 mm at (40,40), 15°; 20×10 mm at (70,70), -20°) save/reload
exactly and stay pending review/unapproved. Moving the second into the synthetic
obstacle produces `fits:false`. Camera and viewport changes leave the saved
physical numbers unchanged.

Visual finding: the model renders and picked anchors/axes are visible; the two
expected logo previews are not visibly seated on the jacket in the inspected
front view, despite both planar footprint checks returning `fits:true`. The
current viewer draws depth-tested flat quads from the calibrated plane; curvature
occlusion is a plausible explanation, not a verified surface-mapping result.
This run therefore does not pass garment-logo visual acceptance. It establishes
that the synthetic planar data path works on the loaded asset, while exposing
the need for explicit garment-surface mapping/rendering acceptance. The Builder
still has no product-model/calibration-to-project bridge, so its previously
passing schematic package roundtrip is not end-to-end jacket evidence.

Scripts, JSON results, exact synthetic session/placement bundles and screenshots
are retained privately under
`private/development-assets/jacket/validation-2026-10-15/` (ignored by Git).
Initial script expectations were corrected to match successful anchor auto-add;
that was a test-authoring error, not an application regression. Final scripts
and records reproduce the checks locally with the retained private model.
Public automated tests continue to use only synthetic tracked fixtures.

## Plain-language and progressive-disclosure acceptance — 2026-10-15

Muse Spark 1.3 Contributor OMP passes supplied the UI changes. Codex independently
reviewed and completed integration: restored the early invalid-fit confirmation
guard, corrected reference-point/axis wording, kept required calibration inputs
and baseline saving visible, retained comparison before review decisions, restored
truncated inspector CSS and missing test baseline setup, separated exact customer
measurements from advanced frame/calibration IDs, and placed the mobile preview
before the review/confirmation sections. Core, schema and packaging modules are
unchanged. The Builder's primary customer download now supplies the selected
complete delivery (HTML or ZIP); the project-only file is a secondary download.

| Check | Environment | Result |
| --- | --- | --- |
| `npm run typecheck` | Domain, viewer and acceptance TypeScript | Pass |
| `npm test` | Node-only, build first | 379/379 |
| `npm run test:e2e -- --workers=4` | Chromium 156.0.8078.4 | 71/71 |
| `npm run test:e2e:chrome -- --workers=2 e2e/customer-editor.spec.ts e2e/self-contained-customer.spec.ts e2e/internal-builder.spec.ts e2e/customer-return-review.spec.ts e2e/inspector-smoke.spec.ts` | Installed Chrome 154.0.8037.98 | 27/27 |
| Independent generated-package journey | Chromium, offline `file://` | Pass |

OS: macOS 27.2 arm64 / Darwin 27.2.0. Desktop 1280×900 and narrow 390×844
viewports. The maintained suites open built or extracted local HTML through
`file://`, with networking disabled, synthetic fixtures, and error/network probes.
The new customer case verifies collapsed advanced sections, basic editing and
confirmation without opening them, visible invalid-fit warnings, keyboard access
to fine tuning, and desktop/mobile preview ordering. Inspector smoke verifies
keyboard disclosure while required measurement fields remain visible. Existing
numeric/drag, zero/multiple-placement, round-trip, stale-confirmation, deterministic
export and obsolete-operation checks are retained.

Independent QA generated a standalone customer delivery and exact baseline,
opened the delivery offline, changed the logo width without advanced controls,
confirmed and downloaded the return, and compared it in the Builder. No console
errors, page errors or HTTP(S) requests occurred. All four UI entry points also
passed desktop/narrow screenshot and horizontal-overflow checks. Codex visually
inspected the screenshots. Development evidence, scripts and command logs are
under `/tmp/logotool-ux-review/`; maintained test artifacts remain ignored.

Intermediate integration runs failed on stale text expectations, closed controls,
missing test baselines and inspector styling; these were corrected before the
passing final runs. No test was skipped and baseline byte equality remains tested.
The supplementary in-app Browser was available but refused `file://`; its refusal
was honored. The repository-required Playwright suite supplied acceptance.

Actual Windows Chrome/Edge, Edge on this host, real calibration/artwork rendering,
and native print-dialog behavior were not validated in this UX pass. The focused
Chrome run does not replace a full Chrome suite gate. Production approval and
Odoo integration remain separate. No uploads, Odoo calls, commits or pushes.

## Branded B+C proof-desk acceptance — 2026-10-16

Muse Spark 1.3 Contributor supplied the OMP implementation pass. Its process
stopped without a final integrated report; Codex independently completed review
and integration, corrected the controller/layout, replaced unwired test skips
with executable assertions and performed final validation. Prior uncommitted
work was preserved. The domain and production schemas remain unchanged.

| Check | Environment | Result |
| --- | --- | --- |
| `npm run typecheck` | Domain, viewer and acceptance TypeScript | Pass |
| `npm test` | Node-only; build first | 382/382, zero skipped |
| `npm run test:e2e -- --workers=3 --max-failures=5` | Chromium 156.0.8078.4 | 78/78, zero skipped |
| `npm run test:e2e:chrome -- --workers=2 e2e/customer-editor.spec.ts e2e/self-contained-customer.spec.ts e2e/internal-builder.spec.ts e2e/customer-return-review.spec.ts e2e/presentation-assets.spec.ts` | Installed Chrome 154.0.8037.98 | 33/33, zero skipped |
| Private standalone proof + all public entry points | Offline Chromium; 1536×1024, 1280×900 and 390×844 | Pass; zero horizontal overflow/errors/HTTP(S) |

OS: macOS 27.2 / Darwin 27.2.0 arm64. Tests open bundled/extracted HTML directly
through `file://` in offline browser contexts, with synthetic fixtures and probes
for console/page errors and network requests. New cases cover minimal single
choices, guided primary actions from zero through repeated placements, exact
reference-view byte preservation, valid/invalid bounded raster assets, stale
decoding, keyboard view-switch drag cancellation, and Builder/self-contained
return review with selected reference assets. Existing mutation, confirmation,
fit, async-race and deterministic package assertions remain.

Codex compared the accepted combined ImageGen concept with native-size desktop
screenshots and inspected narrow layouts. `ui-design.md` records eight comparison
points and intentional differences, including original asset framing and the
separate measurement diagram. Private reference images are not public fixtures.
The demonstration uses explicitly synthetic test geometry; image pixels never
supply physical calibration. Source byte preservation and unchanged physical
exports on view changes are asserted.

Command logs and private visual evidence are retained under
`/tmp/logotool-bc-implementation/`; eight public-entrypoint captures and probes
are under `/tmp/logotool-ux-review/bc-final/`. The supplementary in-app Browser
was available but refused `file://`; that refusal was honored. Repository-required
Playwright supplied acceptance without a server or network workaround.

Actual Windows Chrome/Edge offline delivery remains a release gate. Edge on this
host, native print settings, real garment calibration and physically mapped
artwork were not validated. The focused Chrome run is development evidence,
not a complete Chrome/Edge matrix. No Odoo calls, uploads, publishing, commits
or pushes were performed.
