# Offline testing — offline inspector and Phase 8 workflow prototypes

## Logo Station UX improvements — 2026-11-07

The [complete UX audit](ux-validation-audit-2026-11-07.md) supersedes the historical
211-pass/41-failure report. Paired complete Chromium runs with two workers and
one retry produced **196 passed / 46 failed** on baseline `e583941` and
**222 passed / 30 failed** on published `3bbff0d`, both on macOS 27.2.
The repaired tree on recovered macOS 27.3 produced **231 first-attempt passes /
27 failures / 0 retry recoveries**, zero skips, out of 258.
The OS change prevents an identical-environment final comparison.

Typecheck and `npm test` pass (866 Node tests). The saved installed-Chrome
selection has 42 first-attempt passes and two retry recoveries; both recovered
cases also passed isolated reruns. The recovered macOS 27.3 Chrome selection has 43 first-attempt passes, 0 failures and 2 retry recoveries out of 45; both passed an isolated no-retry rerun. This remains development evidence.
The suite is not green; workflow focus/navigation and wording contracts need
further triage. The audit accounts for all 41 historical failures, names all
original 66 focused executions, documents WI-7 Codex approval, real unload and
false-prompt tests, six mode switches with unchanged blob-URL counts, original
diagnostics, and normal/enlarged idle/active screenshots at all three viewports.

Scoped repairs restore the original enlarged-canvas assertions and fractional
reference picking without changing domain schemas or physical tolerances.
Controls retain 44px heights and accessible names, including existing phone icons. Normal phone/tablet still scroll.
The supplementary browser rejected file URLs; repository Playwright provides
required offline `file://` checks. Edge is absent and failed its launch check.
Windows Chrome/Edge, native print dialogs and physical calibration remain open.
No further main push is included; follow-up work is on the review branch.

## Polygon authoring and return-adoption repair — 2026-11-02

The operator drawing toolbar keeps a persistent command strip and a single
feedback row. Switching Rotate/Polygon/Edit, adding points and showing action
feedback no longer changes the picking canvas position or size. Finish, point
removal and bend actions stay beside the model. Phone controls use labelled,
keyboard-accessible compact icons; the normal view reserves space for Save,
and the enlarged phone controls remain accessible. Long private setup-status
text can still leave less model height than the normal scrollable phone view;
collapsing those technical details is a remaining UX opportunity. The
workspace acceptance assertion checks the complete enlarged canvas fits the
viewport rather than retaining an old toolbar pixel offset.

Adopting a checked return preserves valid product, option, setup and artwork
inclusion. Exact checkbox preservation also retains empty/narrowed choices.
Render-created placement-field mirrors are rebased against the prior project;
real operator drafts retain their apply/discard guard. Immediate save and
reissue no longer require manual reselection or a stale-edit dismissal.

Model setup caches exact handle layout by viewer, view revision and polygon
coordinates. Layer/viewer replacement invalidates it; adapters without a view
revision keep their uncached fallback. Reference/anchor overlays reuse identical
data, and selection-only safe-area styling reuses the existing surface geometry.
Actual presses still verify the live surface. A synthetic work counter checks
that selecting two existing corners does zero additional projections/surface
picks and preserves every point. Real insertion/removal, drag, bend, cancellation,
visibility and save/reopen acceptance remain in place.

The original private 100% handle-overlap report was corrected: native pointer
input already resolved the nearest handle and inserted correctly. Playwright's
locator overlap refusal was not a broken native insertion action. No crowded
edge is now hidden merely to satisfy that locator check. A baseline archive of
unchanged HEAD reproduces the old phone enlargement failure; the current
phone workspace test passes.

OpenCode Contributor workers supplied the initial implementation. Codex stopped
the delegated pass at its bounded handoff, independently reviewed and corrected
layout/control accessibility, cache invalidation and inclusion restoration, then
performed final verification. No domain schemas, calibration authority, physical
geometry, original assets, dependencies or Odoo behavior changed. No external
uploads or Odoo calls were performed during validation.

Final verification: typecheck passes; Node tests pass 866/866; affected-path
Chromium acceptance passes 59/59; installed Chrome acceptance passes 14/14.
The complete repository browser suite and Edge were not run. Acceptance opens
built files directly through offline file:// contexts and asserts zero HTTP(S),
page errors and console errors. Tested viewports include 1440×1000, 1440×900,
1440×781, 1280×900, 1280×720 and 390×844. Environment: Darwin 27.2.0 arm64,
Chromium 156.0.8078.4 and Chrome 156.0.8078.74. Artifacts and before/after
private jacket checks are under /tmp/logotool-ux-repair-20261102/.

The jacket's four safe areas and both Edeka artworks remain test evidence:
its 300 mm reference is provisional, not a physical calibration certificate.
Real Windows Chrome/Edge and actual touch-device release checks remain open.
The repeated private-jacket edit-cycle sample improved from a 2.50 s median
to 2.23 s (three cycles per run on the same Chrome build); this is a small
development sample, not a general benchmark. Collected heap was 8.47→8.55 MB
with stable 31.96 MB backing storage. Short heap samples cannot establish
long-term or GPU leak absence. Point edits on a dense real mesh still require
geometry work; the caching change is not a
claim of instant editing or a general frame-rate guarantee.

## Outline editing merge acceptance — 2026-11-01

Codex reviewed the pending outline editor and its synthetic acceptance tests.
Verification: `npm run typecheck`, `npm test` (866/866), and
`npm run build:demo` passed. The isolated setup suite passed 23/23 with
`npx playwright test e2e/setup-calibration.spec.ts --project=chromium --workers=1 --output=/tmp/logotool-merge-chromium-final`.
Installed Chrome initially passed 21/23 setup tests; two browser-closure
failures both passed in an isolated rerun together with the new outline journey
(3/3). The new journey covers More, renaming, insertion/removal, bend preview,
apply/cancel, and save/reopen. Desktop and narrow screenshots were inspected.

The broad Chromium run was interrupted after a stale tab-label assertion
failed in `internal-builder.spec.ts` (expected “Set logo placements”, actual
“Edit product”). An isolated clean build of unchanged source commit `f3f7060`
reproduced that exact failure; the broad suite is not recorded as passing.

Environment: macOS Darwin 27.2.0 arm64, Chromium 156.0.8078.4 and installed
Chrome 155.0.8059.85. Setup acceptance uses offline `file://` contexts with
synthetic fixtures and checks zero HTTP(S) requests, console errors and page
errors. New outline coverage uses 1280×900 and 390×844; other setup cases
retain their attached per-test viewport/environment records. Logs and isolated
artifacts are under `/tmp/logotool-merge-*`; initial screenshots are in ignored
`test-results/`. Windows Chrome/Edge and physical calibration remain unverified.

## Visual placement controls — 2026-10-27

The operator can move, resize and rotate a selected logo directly on the
calibrated photo/mm diagram or 3D product. Corner handles update physical
width/height and keep the opposite corner fixed. Rotation handles remain
reachable on small artwork. Live artwork, fields and four corner-to-nearest-safe-
side distances follow the transient candidate; saving during a drag still
exports committed geometry. Escape, lost capture and blur cancel the candidate.

Alignment guides use the polygon centroid and actual boundary segments;
footprint-to-edge snapping never substitutes the safe area's bounding box.
Rotation can align with safe-side directions; Shift permits unsnapped fine
adjustment. One-degree keyboard/button steps bypass rotation magnetism.
Selected artwork stays above overlapping siblings. Anchor markers are small
white squares, reference labels are smaller, and corner-distance labels are
smaller than anchor measurements. Original assets and production schemas are
unchanged; no Odoo calls or external uploads were used.

OpenCode Contributor supplied the initial implementation and synthetic
acceptance spec. Codex independently reviewed it, corrected polygon snapping,
shared the opposite-corner resize calculation, completed live preview and
cancellation behavior, and resolved small-handle/label overlap.

| Verification | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm test` | 814/814 Node tests |
| `npm run test:e2e -- --workers=1` | 195/195 Chromium tests, 5.2 minutes |
| `npx playwright test e2e/visual-placement.spec.ts e2e/product-workspace.spec.ts e2e/contextual-workspace.spec.ts --project=chromium --project=chrome --workers=1` | 12/12 focused checks |
| Final label-layout follow-up: `npx playwright test e2e/product-workspace.spec.ts --project=chromium --project=chrome --workers=1` | 4/4 focused checks |

The broad run preceded the final small-handle spacing, fine-step and label
legibility refinements; the focused runs validate those final affected paths.
Geometry stayed unchanged after the 814-test run. Acceptance includes real
pointer gestures, live fields, mid-gesture saves, single-release revisions,
resize cancellation, fine rotation, sibling preservation, save/reopen,
centre guides and Shift override, compact square anchors and non-overlapping
3D distance labels. Rendered screenshots were visually inspected.

Environment: macOS Darwin 27.2.0 arm64; bundled Chromium 156.0.8078.4;
installed Google Chrome 155.0.8059.85; 1280×900 and 390×844. Tests open built
`dist/station/Logo Station.html` and dev artifacts through `file://`, using
offline contexts and synthetic fixtures, and assert zero HTTP(S) requests,
console errors and page errors. Playwright is the repository's primary
acceptance runner. Run logs and final focused screenshots are local under
`/tmp/logotool-visual-placement/`; broad-run artifacts are in ignored
`test-results/`. Windows Chrome/Edge delivery acceptance remains untested;
Edge was not run. Existing provisional planar surface calibration remains
labelled and does not establish true curved-surface arc measurements.

## Whole-workflow browser acceptance — 2026-10-19

Codex completed a native Chrome walkthrough with real local file pickers,
downloads and Print / Save as PDF, followed by independent maintained browser
checks. The walkthrough covered inspector asset/calibration/region authoring
and export, converter → Builder import, customer issue/edit/confirm/save/reopen,
staff review, candidate JSON/PDF, repeated logos, unsafe-fit rejection,
confirmation invalidation, and the revised-proposal/reconfirmation loop.
See [the detailed acceptance record](browser-workflow-acceptance-2026-10-19.md).

The native run found incorrect guidance directing new-placement edits to a
disabled Apply button. The guidance now follows the available add steps;
existing-placement and project-note edits keep their Apply instructions.
Two new maintained full journeys (`e2e/user-workflow.spec.ts`) repeat the
complete operator/customer/reviewer cycle for self-contained HTML and hybrid
ZIP delivery, including desktop/mobile screenshots and download validation.

Independent Codex checks on the final application build:

| Command | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npx playwright test --project=chromium --workers=1` | 133/133, 3.1 minutes |
| `npx playwright test e2e/user-workflow.spec.ts --project=chrome --headed --workers=1` | 2/2, 18.4 seconds |
| `npx playwright test e2e/user-workflow.spec.ts --project=chromium --project=chrome --workers=1` | 4/4, 21.8 seconds, after strengthening the trusted review-history assertion |
| Native Chrome file-picker/download/print walkthrough | Completed with synthetic data; candidate digests matched exact returns |

Environment: macOS Darwin 27.2.0 arm64, Chromium 156.0.8078.4 and installed
Chrome 155.0.8059.80. Maintained contexts are offline, use `file://`, and assert
zero HTTP(S) requests, console errors and page errors. Whole journeys use
1280×900 and 390×844; other specs retain their recorded per-test viewports.
The native window was 2880×1738 device pixels, with DevTools docked during
offline/console inspection. All five pages of the actual native revision-3
operation PDF were rendered and visually checked. Earlier 485 Node and 18
Python checks remain evidence for the unchanged domain/converter code; this
follow-up changes customer guidance and browser acceptance coverage only.

Artifacts are under ignored `.opencode/user-journey-2026-10-18/`, including
`codex-final-chromium/` and `codex-final-chrome/`. The original real-Chrome
whole-suite limitation recorded below is not replaced by the two-journey
Chrome result. Microsoft Edge is absent from both local Applications paths;
it was not installed or substituted. Actual Windows Chrome/Edge offline use,
physical measurement/calibration and verified operator approval remain
unverified release gates. No live Odoo, customer data, uploads or publishing.

## Multiview development acceptance — 2026-10-17

The internal builder now creates a preview-only product from a single GLB,
flat raster, or explicitly assigned front/back/left/right raster. Optional
additional sides and the model travel through both package formats. Customer
Flat/2D/3D views preserve the physical project; model projections and
image-only textured planes are labelled. Unprepared products carry no regions,
calibrations or measurements and cannot host logo placements.

Codex independent final validation: `npm run typecheck`, `npm test` (421 Node
tests), and `npm run test:e2e -- --workers=1` (119/119). A parallel repeat hit
30-second timeouts in existing drag tests and was interrupted; the complete
one-worker run passed without retries. The new model cache regression switches
between equal-length, same-path GLBs with different material bytes, through an
image proxy and back, and checks rendered colors. Pixel checks exclude the
opaque background. Layout tests cover bounded photos/canvases and stable page
height; obsolete reads, bad/external resources, all single-side inputs, legacy
reference preservation and package round trips remain covered.

A final decode-cache correction was then checked with the complete viewer
spec on Chromium and real Chrome: 32/32, including a new controlled pending
bitmap decode across a mode change on the same image. In the earlier focused
Chrome run, 34/37 passed; three browser-process closures included macOS
`CVDisplayLinkCreateWithCGDisplay` failures. The affected checks were rerun
separately: both remaining Builder/reference checks passed 2/2, and the
mode/save/reopen check is included in the 32/32 viewer run. No application
assertion failures remain in those reruns.

Environment: macOS Darwin 27.2.0 arm64; bundled Chromium 156.0.8078.4; default
1280×900 plus per-spec desktop/mobile sizes recorded in test attachments.
Maintained tests open built files via `file://` with offline contexts and assert
zero HTTP(S) requests, console errors and page errors. No Odoo calls.

Local manual acceptance uses the preserved jacket GLB and its front/back/left
photos: combined input, GLB-only and a single left photo, byte-identical draft
save/reopen, all four camera sides, rendered model/proxy screenshots and a true
390×844 mobile viewport. Private originals and acceptance artifacts remain
under ignored `private/development-assets/jacket/`; no right photo is invented.
Independent real Chrome 155.0.8059.80 `file://` offline visual checks confirm
the front and right model renders. Actual Windows Chrome/Edge remains an
untested delivery gate. True garment unfolding, image-to-mesh reconstruction
and real physical calibration are not implemented by this presentation slice.

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
npm run build:station       # single-entry station only: dist/station/Logo Station.html
npm run build:dev:preview   # dev-only transport preview + synthetic customer/reviewer artifacts (dist/dev/)
npm run build:dev:inspector # dev-only asset inspector (dist/dev/asset-inspector.html)
```

`npm run typecheck` checks domain, viewer, and e2e/config TypeScript.
Unit/domain tests remain separate: `npm test`
(build + `node --test dist/tests-ts/*.test.js`). No live Odoo calls anywhere
in automated tests. `node scripts/convert-area-bundle.mjs` converts an
inspector area-bundle export to a Builder-ready prepared product (needs
`npm run build` first; see `docs/internal-builder.md`).

Windows operators run the same gates through
`scripts/run-windows-acceptance.ps1 -NetworkDisabled` from the repo root
after disabling networking; it writes a portable per-scope report
(environment, logs, per-browser Playwright artifacts, summary). See
`docs/release-acceptance.md`. macOS runs remain development evidence only.

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
- `operation-document-assets.spec.ts` — package-asset operation-document evidence (2026-10-18, 7 tests): inert header-validated raster artwork previews with illustrative captions, corrupt/non-raster explicit placeholders, header-valid-but-undecodable native-decode fallback, illustrative reference views with explicit missing notes, revision/digest consistency, approval-independent pending status, narrow-viewport overflow.
- `prepared-product-import.spec.ts` — inspector-bridge→Builder roundtrip (2026-10-18, 3 tests): prepared product import with exact mm geometry + verbatim sidecar/area-bundle evidence, malformed-import atomicity, customer placement/confirm/save/reopen in the imported mm region with explicit unsafe-fit rejection, baseline review with consistent candidate JSON. Fixture generated by `scripts/convert-area-bundle.mjs`; desktop/mobile screenshots attached per test.
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

## Internal Builder proof-desk acceptance — 2026-10-17

The Muse Spark 1.3 Contributor OMP pass supplied the initial redesign. It stopped
at its process deadline without a final integrated report. Codex independently
reviewed and completed integration, retaining the domain/packaging behavior and
all byte-equality/race assertions. Guided Prepare and Review modes replace the
long form; raw identifiers, detailed comparisons and alternate formats are
progressively disclosed. See `ui-design.md` for the visual comparison ledger.

| Check | Environment | Result |
| --- | --- | --- |
| `npm run typecheck` | Domain/viewer/e2e TypeScript | Pass |
| `npm test` | Node-only; builds first | 382/382, zero skipped |
| `npm run test:e2e -- --workers=3 --max-failures=2` | Chromium156.0.8078.4 | 80/80, zero skipped |
| `npm run test:e2e:chrome -- --workers=2 e2e/internal-builder.spec.ts e2e/presentation-assets.spec.ts` | Installed Chrome155.0.8059.80 | 19/19, zero skipped |
| Independent visual/interaction journey | Offline file:// Chromium;1536×1024,1280×900,390×844 | 21 state/viewport captures; clean errors/network/overflow probes |

OS: macOS / Darwin27.2.0 arm64. All maintained cases use synthetic fixtures,
built/extracted local HTML, offline contexts and zero console/page-error or
HTTP(S)-request assertions. The focused Chrome suite covers the final Builder
and presentation asset changes; it is not a complete Chrome matrix. Final
status-copy/visibility cleanup was rechecked in this focused run and screenshots.

The staff journey checks both desktop and narrow viewports without opening
technical settings: choose a source, select items, see actionable missing-field
feedback, enter three job details, generate, download both files, compare the
embedded customer bytes with the office copy, switch modes without losing output,
and reject a bad replacement while retaining exact office-copy bytes. Existing
checks also open the delivered customer HTML, edit/confirm/save the return, restore
a saved office copy in a fresh session and compare/export/print the same candidate.
Automatic IDs stay stable; explicit overrides, empty/oversized IDs, zero-logo
selection, deterministic regeneration, obsolete reads/hashes, failed imports and
selected optional presentation assets remain covered.

Independent screenshots exercised all seven steps per viewport and a real
customer width edit, confirmation, return download and Builder comparison.
Codex inspected ImageGen references and final screenshots with `view_image`.
Intermediate runs exposed stale copy expectations, test-helper navigation races,
unwrapped technical text and insufficient mobile step spacing. These were
corrected before the passing runs; assertions were preserved and no tests skipped.
Logs/scripts/screenshots are retained outside tracked source under
`/tmp/logotool-builder-redesign/`. Design references/prompts remain ignored under
`private/design-concepts/2026-10-17/internal-builder/`.

The supplementary in-app Browser's earlier file:// refusal remains honored.
The project-required Playwright suite supplied offline acceptance without a
server or network workaround. Actual Windows Chrome/Edge, this host's Edge,
real production calibration, native print-dialog choices and staff usability
with representative operators remain unvalidated. Passing automated journeys
does not establish that every staff member needs no introduction. No Odoo calls,
uploads, publishing, dependency installs, commits or pushes in this redesign.

## Create a project acceptance — 2026-10-17

The Builder's new Start path creates a fresh revision-1 draft directly from
bundled prepared product definitions, with zero placements and reset job details
and approval evidence. No previous project file is required. The embedded
catalogue is explicitly synthetic and does not establish production calibration.
Local PNG/JPEG/WebP artwork import preserves exact bytes, original role and
pixel dimensions, while physical sizes remain explicit customer choices.

Codex independently integrated the Muse Spark implementation, preserving the
prior Builder redesign. Corrections include fresh IDs after manual overrides,
all choice retention on artwork import, collision-safe IDs and correct media
extensions, decoded/header dimension agreement, obsolete-read rejection,
atomic catalogue validation and rejection of non-JSON/nonfinite physical input
before cloning. Unselected product options collapse and the desktop action rail
stays accessible alongside longer lists.

The new acceptance cases cover starting without an input project, prepared
product/calibration identity, empty placement lists and cleared histories,
zero/multiple logos, duplicate filenames, exact new artwork byte preservation,
PNG and JPEG delivery/thumbnails, stable repeated output, manual-ID reset,
product/variant/setup/logo subset retention, malformed/oversized images,
unreadable files and obsolete decoding after replacement. A delivered customer
HTML is opened without sibling files, the imported logo is placed and sized,
the customer confirms and saves, and a fresh Builder compares the return with
the saved office copy. Existing package and presentation-asset tests remain.

Independent offline journeys captured Start, choices, artwork, details,
download and return review at1536×1024,1280×900 and390×844. Codex inspected both
the established proof-desk references and the latest screenshots with
`view_image`: branding, typography, white surfaces, row/rail layout, control
hierarchy, plain copy and responsive flow remain consistent. Dynamic fixture
content replaces illustrative concept samples. No new raster UI was generated
for this extension of the existing design system. Scripts, logs and18 captures
are outside tracked source at `/tmp/logotool-create-project/visual-final/`.

One full parallel run timed out awaiting a download in the existing placement
restore case. Its source/assertions were unchanged; it passed an isolated rerun
in8.5seconds. Final full validation uses two workers without skipped tests or
increased timeouts. Intermediate new-flow checks also caught navigation/copy
expectations, JPEG path assumptions and an unapplied-notes test step, all fixed
while retaining exact byte and numeric assertions.

Actual Windows Chrome/Edge, real product calibration/catalogue deployment and
representative staff usability remain separate gates. The supplementary in-app
Browser's prior file:// refusal was honored; repository-required offline
Playwright remains primary. No web server, HTTP(S) calls, Odoo calls, uploads,
publishing, dependency installs, commits or pushes were used for this work.

| Final check | Environment | Result |
| --- | --- | --- |
| `npm run typecheck` | Domain/viewer/e2e TypeScript | Pass |
| `npm test` | Node-only; build first | 393/393; zero skipped |
| `npm run test:e2e -- --workers=2 --max-failures=2` | Chromium156.0.8078.4, macOS/Darwin27.2.0arm64, offline file:// | 89/89; zero skipped |
| `npm run test:e2e:chrome -- --workers=2 e2e/new-project.spec.ts e2e/internal-builder.spec.ts e2e/presentation-assets.spec.ts` | Installed Chrome155.0.8059.80, same host/offline | 28/28; zero skipped |
| Independent creation/delivery/edit/confirmation/return journey | Chromium;1536×1024,1280×900,390×844 | 18 state/viewport captures; zero horizontal overflow, console/page errors or HTTP(S) requests |

Final command logs are `/tmp/logotool-create-project/{typecheck.log,unit.log,full-accepted.log,chrome-accepted.log}`.
The focused Chrome run is development evidence for these flows, not the full
Chrome/Edge matrix or actual Windows validation.

## Prepared-product bridge acceptance — 2026-10-18

Lead-integrated after worker delivery (no OMP): the pure inspector bridge
(`src/core/inspector-bridge`, 26 Node tests), Builder prepared-product intake
(`src/core/project-builder/prepared-import`, 13 Node tests), conversion
entrypoint (`scripts/convert-area-bundle.mjs`, 7 Node CLI tests), Builder
import UI with sidecar/verbatim-evidence packaging, and operation-document
asset plumbing (artwork previews, reference views, decode fallback, `__proto__`
guards) are integrated and validated on this host.

| Check | Environment | Result |
| --- | --- | --- |
| `npm run typecheck` | Node 26.10.0, TypeScript (domain + viewer + e2e) | Pass |
| `npm test` | Node-only; builds first | 479/479, zero skipped |
| `python3 -m unittest discover -s tests` | repo Python tooling | 18/18 OK |
| `npm run test:e2e -- --workers=1` | macOS 27.2 arm64, Chromium 156.0.8078.4, offline `file://` | 129/130; single load-timeout in existing `presentation-assets` case, passes solo and in file/subset runs (host-load flake, unchanged code path) |
| `npx playwright test --project=chrome e2e/prepared-product-import.spec.ts e2e/operation-document-assets.spec.ts` | Installed Chrome 155.0.8059.80, same host/offline | 10/10 |
| `npm run test:e2e:chrome -- --workers=1` | Same installed Chrome, full suite | 127/130; 3 browser-process closures (`Target page, context or browser has been closed`) in untouched multiview/drag/standalone specs, no application assertion failures |

Every browser test opens built `dist/*.html` (or extracted/generated packages in
portable temp dirs with spaces) through `file://` in offline contexts and
asserts zero console/page errors and zero HTTP(S) requests. New fixtures are
tracked synthetics: `e2e/fixtures/bridge-area-bundle.json`,
`bridge-labels.json`, and script-generated `prepared-bridge-product.json`
(pinned by test to equal fresh conversion output byte-for-byte, including the
verbatim evidence text and its SHA-256). The offline roundtrip covers prepared
import → issue → placement/confirm/save/reopen in the same mm regions with an
explicit unsafe-fit rejection → baseline review → consistent candidate JSON.
All documents stay `candidate-pending-review`; schemas remain provisional.

Screenshots inspected: Builder Save & send, customer placement review with
measured diagram and confirmation, reviewer operation-document with decode
fallback. macOS runs are development evidence; actual Windows Chrome/Edge,
Edge on any host, real calibration/artwork rendering, native print-dialog
behavior and operator usability remain untested gates. See
`docs/release-acceptance.md`, `docs/operator-pilot-checklist.md` and
`docs/release-readiness.md`.

### Codex correction to the initial timeout diagnosis

Independent failure artifacts from the first Codex full run show the Builder
already on Choose items with both products loaded. The failing expectation
used `source-status` filtered to visible elements after Start became hidden.
This is a navigation/locator race, not evidence of a slow archive load. Codex
replaced only that status expectation with its stable locator; all subsequent
step, selection, asset-byte and return assertions remain intact. Earlier
references to a host-load flake above were the lead's initial interpretation,
now superseded by these artifacts. No timeout increases, sharding, retries
or skipped tests were used as a remedy.

## Codex independent final acceptance — 2026-10-18

OpenCode v2 used `opencode-go/muse-spark-1.3-contributor` for the lead and
workers. Codex independently reviewed the integrated changes, required evidence
hash verification and exact UTF-8/BOM preservation, corrected the status
locator race, and reviewed Windows PowerShell 5.1 path compatibility.

Environment: macOS / Darwin 27.2.0 arm64; Node 26.10.0; bundled Chromium
156.0.8078.4 and installed Google Chrome 155.0.8059.80. Browser contexts
were offline, opening built/extracted/generated files directly through
`file://`. Default viewport 1280×900; specs also cover 390×844 and their
recorded desktop sizes. Passing cases assert zero console/page errors and
zero HTTP(S) requests. Host networking was not claimed disabled on macOS.

| Independent check | Result |
| --- | --- |
| `npm run typecheck` | Pass, all three TypeScript configurations |
| `npm test` | 485/485; zero skipped |
| `python3 -m unittest discover -s tests -v` | 18/18 OK; synthetic captures only |
| Focused Chromium prepared import + presentation | 11/11, including tampered evidence and obsolete hash rejection |
| `npm run test:e2e -- --workers=1` | 131/131 Chromium; no retries/skips |
| `npm run test:e2e:chrome -- --workers=1` | 128/131; two browser-process closures and one transport test timeout |
| Traced focused Chrome rerun of those three failures | 3/3; separate diagnostic evidence, not a green full suite |
| Edge launch check | Hard failure: installed `msedge` distribution missing; functional acceptance untested |
| Actual Windows Chrome/Edge; Windows runner execution | Untested; release gate remains open |

The Chrome closures occurred in single-right-image creation and basic
inspector dragging, with `CVDisplayLinkCreateWithCGDisplay` and macOS process
policy diagnostics in the browser log. The transport zero-placement test
timed out without a page snapshot. All three pass together in a traced
single-worker rerun, without source changes, retries or increased timeouts.
No application assertion failure reproduced in that rerun; the full Chrome
gate nevertheless remains incomplete.

The current 32 Node files include 26 bridge, 14 prepared-import, 12 converter
CLI and 12 operation-document asset tests. There are 23 e2e spec files / 131
cases per browser. New acceptance covers actual converter output, exact
source evidence preservation, safe and unsafe placement, customer confirmation,
save/reopen, baseline review and agreement with deterministic candidate JSON.
Native decode failures and unusual configuration IDs remain covered.

Codex inspected desktop/mobile workflow screenshots, then printed two
synthetic A4 operation documents with raster artwork and a product reference
(7 pages; 9 pages with 85 instruction lines). Poppler renders of all 16 pages
were visually inspected; extracted text confirms every page has the project,
revision, pending status and correct page numbering, with all 85 instruction
lines present. Native OS print-dialog settings and physical printer scaling
remain unverified.

Local ignored evidence is retained under
`.opencode/release-readiness-2026-10-18/`: `codex-unit-final.log`,
`codex-typecheck-final.log`, `codex-environment.json`,
`codex-chromium-final.log`, `codex-chrome-final.log`,
`codex-chrome-triage.log`, `codex-edge.log`, separate browser artifacts/HTML
reports, print PDFs and page renders. The initial failed Chromium evidence is
also retained separately. No Odoo calls, customer evidence reads, uploads,
installs, publishing, commits or pushes were performed. Schemas stay
provisional; production approval is not conferred.

## Operator UX and model-document acceptance — 2026-10-28

The ten operator UX areas are implemented: visual artwork Place/drag/drop,
viewport-sized placement with persistent actions and overflow cues, Pan in
setup and placement, orientation-preserving Fit, visible-surface artwork
controls, unified corner/numeric ratio editing, committed-change Undo/Redo,
Embroidery/Heat Seal/Print and explicitly named additional methods, and local
model-derived operational views with physical references and measurements.
Photos are optional for model-only jobs. Presentation cameras/order survive
save/reopen independently of production mm and revision.

| Independent Codex verification | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm test` | 849/849 Node tests, no skips |
| Complete `npx playwright test --project=chromium --max-failures=5` | 202/202 pass |
| Installed Chrome: model documents, placement UX, rear shell rendering, product workspace | 9/9 pass |
| Final layout refinement: placement UX + direct images job, Chromium and Chrome | 4/4 pass |

The complete run preceded the final small rail-layout refinement. Its affected
model/photo workflows passed the final targeted run on both browsers. Core
controls are checked with intersection ratio 1, including ancestor clipping,
at 1280x720, 1440x900, 1536x864 and 1920x1080; model setup/placement also has
390x844 acceptance. Enlarged desktop canvas area is at least the normal area;
mobile enlarged setup is larger than normal. Tests exercise native artwork
drag/drop at its actual surface location, pending numeric + pointer commits,
proportion locking, one gesture/one revision, Undo/Redo, custom methods, and
front/back artwork visibility in both addition orders.

Measured model-only front-only/front+back journeys check clean applied
artwork pixels, direct physical reference picks, document view adjustment and
reordering, unchanged production geometry, metadata persistence, and identical
operator JSON after save/reopen. Four exported PDFs (initial and adjusted,
front-only and front/back) were rendered with Poppler and visually checked.
Each is one A4 landscape page, including the deliberately added third view,
with numbered compact specifications and matching physical mm labels.

Environment: macOS Darwin 27.2.0 arm64; bundled Chromium 156.0.8078.4; installed
Google Chrome 155.0.8059.85. All browser contexts are offline and use file://
with synthetic fixtures, asserting zero HTTP(S) requests, console errors and
page errors. Logs and rendered review artifacts are local under
`/tmp/logotool-ux-20261027/`; maintained tests reproduce their own fixtures in
portable Playwright output directories. No Odoo calls, uploads or publishing.

Actual Windows Chrome/Edge offline acceptance remains an untested delivery
release gate; Edge was not run. Established provisional planar/chord
calibration remains provisional. Undo history is session-local for committed
changes; native field-text undo and explicit setup staging are preserved.

## Precise polygon setup and compact workspace — 2026-10-28

Photo and 3D setup use point-by-point **Polygon** drawing. Click to add a
white square corner; activate the first square, Finish or Enter to close.
Backspace / Undo removes the last draft point; Escape cancels the drawing.
The 3D editor consumes Escape before the enlarged-workspace dialog, so one
Escape cancels editing and keeps the work surface open. Focused action buttons
retain their own Enter behavior, including Undo point.

Rectangle remains a starting outline. Every corner moves independently;
nonrectangular and reopened rings retain their handles. Smaller edge squares
insert points; Delete on a focused corner removes it, guarded by the minimum
three vertices and polygon validator. Photo arrow-key nudges remain physical
millimetres. Model changes require real surface picks; hidden or occluded
handles are suppressed. Missed surface releases, invalid/self-crossing polygons,
Escape and pointer interruption preserve the last valid staged geometry.
Source assets, production schemas, calibration units and explicit Save behavior
are unchanged. Curved model outlines retain the existing provisional planar
projection; this change does not establish a geodesic/curved production map.

The 3D toolbar is compact, the settings rail is 250px, corner-list fallbacks
sit in a disclosure, and the canvas gets 65vh in ordinary desktop setup.
Initial framing uses the existing tighter orientation-preserving fit. Enlarging
or closing a fitted (100%) view measures its new aspect ratio before re-fitting;
zoomed inspection remains under operator control. Image toolbars and hints are
also compact. Compared to the baseline, observed canvas-area increases were:

| Viewport | Normal setup | Enlarged setup |
| --- | --- | --- |
| 1440×900 | +31.5% | +32.4% |
| 1280×720 | +32.6% | +45.2% |
| 390×844 | +3.9% | +39.2% |

The canvas starts about 149–156 CSS pixels earlier in these captures. Codex
visually inspected the user references and the before/after synthetic-model
screenshots: toolbar density, white backgrounds/FlexiTog red accents,
typography, rail width, product framing, white square handles, mobile action
reachability and horizontal overflow. Intentional copy changes are Freehand →
Polygon, shorter drawing hints and an accessible name input without a tall
visible label. No new visual assets or generated design concept were needed
for this targeted change within the established design system.

Validation environment: macOS/Darwin 27.2.0 arm64; Node 26.10.0; bundled Chromium
156.0.8078.4; installed Google Chrome 155.0.8059.85. Every browser context uses
offline `file://`, synthetic fixtures and assertions for zero HTTP(S) requests,
console errors and page errors. Context offline mode is development evidence;
host networking is not claimed disabled. Supplementary IAB navigation timed out
waiting for its webview to attach; required repository Playwright remained the
primary acceptance path. Actual Windows Chrome/Edge remains untested, and
installed Edge is absent on this host.

The revised tests check rectangle → independent corner → second independent
edit, unchanged sibling vertices, insertion/removal, invalid release and
self-crossing-edit rollback, keyboard/pointer cancellation, no movement-trace
sampling, point undo, first-square closure, Enter completion, exact coordinates
after save/reopen, calibrated zoom, mobile controls, canvas space and the
existing customer/production-document flows. Raw logs, screenshots and a
separate synthetic rendered proof are retained outside tracked source at
`/tmp/logotool-polygon-20261028/`. No Odoo calls, uploads, installs, publication,
commits or pushes were performed.

| Independent Codex check | Result |
| --- | --- |
| `npm run typecheck` | Pass across domain, viewer and e2e configurations |
| `npm test` | 849/849 pass; zero skipped |
| Full Chromium regression, two workers | 201/202; the only failing assertion still expected the square's fill width without its 1.5px visible border |
| Corrected high-resolution/narrow marker check | Pass; asserts a 10.5px painted square (9px fill + border), white fill and ≥20px hit targets |
| Final Chromium affected flows: contextual workspace, product workspace, setup calibration, visual product setup | 28/28 pass, zero retries/skips; includes final hidden-pane fit guard and geometry/keyboard checks |
| Installed Chrome affected flows | Initial 24/28; four traced focused rechecks pass, covering the corrected marker expectation, self-crossing input and both browser-process closures |
| Independent rendered model proof | Pass: repeated independent corner edits, insertion, save, Escape cancellation without closing the enlarged workspace; zero console/page errors or HTTP(S) requests |
| Latest visual review | 1440×900, 1280×720, 390×844; normal/enlarged views; rendered model present and zero horizontal overflow |
| Actual Windows Chrome/Edge | Untested release gate |

The initial marker test also used a circle-only selector, replaced with a
rectangle selector. Its original 12px minimum visual circle was replaced with
an exact small-square check while retaining the original comfortable hit-target
minimum, including on a 2000px photo and a 480px-wide viewport. The invalid-edit
check now creates an actual crossing: releasing at a neighbour's fractional
screen position can leave a valid tiny gap after browser pointer rounding, so
coincidence is not a reliable invalid-edit fixture.

The full Chromium run preceded the final hidden-pane fit guard, nearest-handle
resolution and final assertion corrections; the final 28-case affected-flow run passed on the latest
application source. There is no claim of a fresh green 202-case invocation.
Two initial Chrome failures closed a page/context/browser during download or
context cleanup. Their logs contain macOS task-policy/CVDisplayLink diagnostics;
those diagnostics do not establish a cause. Both pass in the four-case traced
recheck without application changes. The initial complete 28-case Chrome
invocation is therefore not reported as green.

Dense-outline regression checks exposed overlapping invisible hit targets: DOM
stacking could move a neighbouring vertex on a many-point surface ring. Both
photo and model pointer handlers now choose the nearest visible handle centre.
This preserves comfortable targets without changing the intended vertex or
accidentally inserting an edge point. A dense eight-point photo ring and a
many-point surface-following model ring are exercised with exact checks that only
the selected native/mm point changes. The dedicated photo/general-model/curved-
model cases pass on Chromium and installed Chrome (6/6).

After nearest-handle resolution, the final affected-flow Chromium run is
28/28 green (`complete.log`), the cross-browser dense-outline cases are 6/6
green (`dense.log`), and the final Chrome contextual/photo/save/reopen cases
are 5/5 green (`photo-chrome.log`). The latest compiled Node-only suite is
849/849 green (`complete-unit.log`). Final type checking and diff whitespace
checks pass. The independent proof and three-viewport captures were regenerated
from the final built station. No further implementation changes followed.

### 2026-10-29 — Unified product editing workspace

The operator now opens one **Edit product** workspace for measurements, safe
areas and logo placement. Measurements & areas / Logos are tool modes within
that workspace. Product/option selection, enlargement and Save job are common
controls. The persistent right column is removed. Measure, Areas, artwork and
photo properties use the same dismissible canvas context-panel primitive;
panels sit inside the unscaled canvas boundary and cannot cover setup Save.
Calibration picking and drawing dismiss the relevant panel. Escape cancels an
edit first, then dismisses an open panel, then leaves the enlarged workspace.

The model path borrows the existing canvas, viewer and loaded model across tool
modes. Navigating between tools does not reload the model or rewrite millimetre
geometry. The setup adapter suspends its pointer handlers while the placement
adapter owns the surface. The calibration label is hidden in Logos (it could
completely obscure a small logo); returning to setup restores the reference.
Photo setup shares the editor shell and popup primitive with the model tools;
its existing calibrated SVG adapter remains separate from the 3D renderer.

Independent acceptance uses synthetic inputs and the built
`dist/station/Logo Station.html` directly through `file://`, with Playwright
contexts offline and assertions for zero HTTP(S), console and page errors.
Environment: macOS 27.2 (26B118), arm64; bundled Chromium 156.0.8078.4 and
installed Google Chrome 155.0.8059.85. Viewports: 1440×900, 1280×900,
1280×720, 390×844; photo-marker checks additionally resize to 480×900.
Per-run environment attachments, screenshots, saved package comparisons and
logs are under `/tmp/logotool-canvas-context-20261028/`.

`e2e/unified-editor.spec.ts` asserts the actual canvas DOM identity across
calibration → area creation → logo placement → setup, contextual disclosure,
Escape priority, canvas width/height, retained placements, exact saved product
geometry, and no horizontal overflow. Existing contextual/photo, setup,
physical logo manipulation and model-document save/reopen acceptance tests now
navigate the unified workspace and explicitly disclose contextual fields.
The Chromium core run also exposed and verified fixes for precision disclosure
state lost during reparenting and a retained calibration label hiding artwork.

OpenCode v2 Contributor produced the bounded shared-panel/borrowed-viewer
pieces. Codex integrated the unified shell, independently reviewed ownership
and lifecycle, corrected integration failures and ran final validation. The
original dirty polygon changes were preserved; no domain schema, Odoo calls,
external uploads, commits or publishing are part of this change.

Browser/IAB attachment timed out earlier in this session; the repository's
explicitly required Playwright offline suite supplies deterministic acceptance.
Actual Windows Chrome/Edge acceptance remains outstanding. These macOS runs do
not satisfy that delivery release gate. The complete repository e2e matrix is
not claimed by this scoped acceptance.

Final results: `npm run typecheck` passes; `npm test` passes 849/849;
`final-chromium.log` passes all 32 scoped acceptance cases;
`final-chrome2.log` passes all 11 shared-editor, photo, logo-manipulation and
model-document cases on installed Chrome. A prior Chrome invocation timed out
on its first unified-editor case; it is retained as failed evidence in
`final-chrome.log`, not counted as green. The clean subsequent full 11-case
invocation passed. After one final CSS change to put status text above (rather
than over) footer actions, `final-layout.log` passes all 6 three-viewport
Chromium/Chrome journeys with an added assertion that Review remains inside the
viewport. Screenshots in `final-layout/` show the final built layout. Build and
`git diff --check` pass; no further implementation changes followed.

### 2026-10-29 — Blank Logos canvas and clipped page top

Reported screenshots showed a loaded 3D product in Measurements, then an empty
region diagram in Logos before any safe area had been saved. The preceding
acceptance had entered Logos after saving calibration/areas and missed this
state. New offline regression tests reproduce the missing model through both
the mode button and Prepare's Set logo placements action. A separate baseline
check reproduces the header at y=-20 at 1280×720 (`baseline-top.log`).

Model display now depends on the available asset rather than the existence of
physical regions. A model with missing, stale or unsupported setup supplies an
empty display mapping and remains visible on the same canvas/viewer. The stage
shows the existing Set up product action; placement, anchor, movement, commit
and drop mapping require a current calibrated region. No pixels, mesh units or
preview defaults are promoted to physical geometry. Independent saved-package
checks assert zero regions, calibrations and placements after an attempted
unconfigured placement. The blocked Place action deliberately opens setup.
The calibrated and preview states use one adapter and callback set, with
readiness checked at edit time.

Editor entry and setup routing return the window to the page top. Focus uses
preventScroll, the normal editor no longer locks the body at a stale scroll
offset, and canvas height accounts for viewport space. Back retains its
Prepare-job destination. Header, navigation, editor modes and desktop Save
bounds are checked after resize, calibration/save, enlargement/close and
Prepare → Logos → Measurements. Four viewport sizes include the reported
screenshot's approximate CSS dimensions: 1440×900, 1440×781, 1280×720 and
390×844; desktop checks additionally resize 40 px shorter and restore.

Independent review also reproduced a texture-loading race: a same-asset UI
refresh incremented the model generation while its original load was pending,
so its completion could never mark the shared viewer ready. Generation changes
now belong to disposal or replacement loads. A self-contained textured GLB
fixture holds real texture decoding behind a test gate, switches tools, then
releases it. The old code fails (`load-baseline2.log`); the corrected code
completes that same model load (`load-fixed.log`). This instrumentation lives
only in the test, not the shipped application.

OpenCode Contributor lead/worker supplied a bounded initial implementation.
Codex independently reproduced both reported states, reviewed and simplified
the shared-adapter integration, tightened edit guards, corrected the loading
race, and performed final acceptance. Evidence is retained under
`/tmp/logotool-editor-bugs-20261029/`; fixtures are synthetic, the built station
opens directly over `file://`, all contexts are offline, and tests assert zero
HTTP(S), page and console errors. OS is macOS 27.2 (26B118), arm64; browser
versions and viewports are recorded in each run's environment attachments.
One earlier Chrome invocation closed its final context with macOS
CVDisplayLink/GPU errors (`final-chrome.log`, 18 passes/1 failure); it is not
reported as a clean run. Later focused runs use fresh browser invocations.
Windows Chrome/Edge release validation and the complete repository e2e matrix
remain outside this macOS scoped acceptance. No Odoo calls, external asset
uploads, publication, commits or pushes are part of this repair.

Final validation for this repair: `npm run typecheck` and the production build
pass; `npm test` passes 849/849. `final-chromium2.log` passes 45/45 cases (the
previous 32 affected workflows plus 13 new regressions). Installed Chrome
passes 13/13 new regressions (`final-chrome-regressions.log`) and 7/7 calibrated
shared-editor/manipulation/document cases (`final-chrome-core.log`) in clean
fresh invocations. The final screenshot review includes the normal 1280×720
header and the still-unconfigured Logos model. `git diff --check` passes. No
further implementation changes followed these checks.

### 2026-10-29 — Finish area label and toolbar alignment

The normal model-toolbar rule painted every button white with greater CSS
specificity than `.btn-primary`, while the primary button retained white text.
The baseline test measures a 1:1 contrast ratio (`baseline.log`). Scoped primary
styles now retain the red fill and white label through normal, hover, disabled
and keyboard-focus states. The drawing-action group's inherited top margin is
removed, and buttons, zoom select and area-name input use the same 32px height.
A first narrow-screen check caught a remaining 30px/32px mismatch (`check.log`);
that mismatch is corrected. Changes are CSS only; drawing validation is intact.

The new Finish acceptance clicks the actual button (no Enter workaround),
checks its visible label and at least 4.5:1 contrast in normal/hover/keyboard
focus, checks matching control heights and same-row alignment, verifies that
two points cannot finish, then completes and saves two triangular areas in
normal/enlarged workspaces. Parsed packages contain both three-point regions.
Screenshots at 1440×781, 1280×720 and 390×844 were independently inspected.

`npm run typecheck`, `npm run build` and `git diff --check` pass. The final
focused offline suite passes 20/20 across bundled Chromium and installed Chrome
on macOS 27.2, including header/resize and shared-canvas regression checks.
The built station is opened directly through `file://` with zero HTTP(S),
console and page errors asserted; OS/browser/version/viewport are attached by
the suite. Logs, screenshots and saved synthetic packages are under
`/tmp/logotool-finish-toolbar-20261029/final/` and `final.log` in its parent.
Domain code did not change; the Node domain suite was not repeated for this
CSS repair. Windows Chrome/Edge delivery validation remains outstanding.

### 2026-10-29 — Dense area handles and artwork popup

The reported dense selected area caused `syncHandleLayer` to project and
surface-pick every corner and edge midpoint on every viewer frame, including
idle frames. The independent 64-point synthetic baseline performed 2,560
`pickSurface` calls in 20 idle frames (`baseline.log`). The viewer now exposes
a camera/viewport revision, and setup handles wait 120 ms after navigation
settles before running their visibility checks. Idle frames skip this work;
handles and the drawing guide hide while the camera moves. Exact surface
verification on handle presses, all stored points and curved boundary samples
remain intact. Planar rectangle drags already produce four verified corners;
the 32-point fallback remains necessary for curved patches.

The artwork popup now wraps cards and full-width Place buttons, keeps long
names readable, and shows the empty-placement message once. An uncalibrated
stale area offers **Fit scale to use these areas** beside recompute. The tested
recovery is: draw area → Fit scale action → pick reference A/B → enter mm and
fit → recompute → save setup → Logos → Place. This preserves the existing area
and calibration requirements. Missing or stale calibration never becomes a
usable physical region merely because it is visible on the model.

Codex independently reproduced the defects, reviewed the Contributor lead's
implementation, added the recovery action, removed unused timer state, cleared
timers on teardown and hid stale drawing guides during navigation. The helper
recorded a scope-inventory anomaly because it included concurrent Codex-owned
tests and an explicitly authorized expansion to `src/viewer/model-viewer.ts`;
that record is retained, not treated as automatic approval. Final acceptance
uses the independently reviewed integrated diff and checks below.

Environment: macOS/Darwin 27.2.0 arm64, Node 26.10.0, bundled Chromium
156.0.8078.4 and installed Google Chrome 155.0.8059.85. Built station and
self-contained model harnesses run directly over `file://` in offline browser
contexts, with synthetic assets. Acceptance viewports: 1440×900, 1440×781,
1280×900, 1280×720 and 390×844; popup checks cover normal and enlarged mode.
The Browser plugin APIs/skill are not available in this session; project-required
repo Playwright remains the primary acceptance mechanism.

| Check | Result |
| --- | --- |
| Typecheck and station build | Pass |
| Unit/domain suite (`npm test`) | 849/849 pass |
| Scoped offline browser acceptance | 20/20 pass, 10 Chromium + 10 Chrome |
| Page identity, meaningful content, no error overlay | Pass |
| Console errors, page errors, HTTP(S) requests | Zero |
| Desktop/phone screenshots and popup bounds | Pass |
| Area recovery, corner editing, insertion, rollback, curved fill and occlusion | Pass |
| Shared canvas and saved geometry across mode changes | Pass |

For the 64-point fixture, measured over 20 frames: idle has zero projections
and zero surface picks; a discrete zoom performs one 128-handle pass; continuous
zoom performs zero projections/picks while moving. Exact saved coordinates are
unchanged. These deterministic work counts demonstrate removal of the repeated
work; they are not a frame-rate benchmark on the user's private jacket model.

Evidence: `/tmp/logotool-points-20261029/`, including baseline failures,
`unit.log`, `build-final.log`, `typecheck-accepted.log`, `final.log`, and `final/`
with screenshots, environment attachments, saved synthetic packages and
`point-work.json`. Final browser command:

```sh
npx playwright test e2e/editor-regressions.spec.ts e2e/unified-editor.spec.ts e2e/setup-calibration.spec.ts --project=chromium --project=chrome --workers=1 --grep 'artwork popup wraps|uncalibrated area offers|dense model area|model tools: independent|model rectangle drag on a non-planar|model safe-area fill|one editing workspace' --output=/tmp/logotool-points-20261029/final
```

Windows Chrome/Edge delivery acceptance and performance on the actual private
jacket model remain unverified. No Odoo calls, external uploads or publication
were performed for this repair.


## Interactive customer garment proof — 2026-10-30

The customer editor reuses the operator's calibrated model placement renderer.
A valid packaged model mapping opens the garment with its actual artwork;
validated photos open in photo mode, while missing or invalid mappings retain
an explicit diagram/reference fallback. Named logo buttons, placement requests
and Review are the normal customer controls. Exact position, size, rotation and
method remain inside optional disclosures. On narrow screens the model stays
visible while the editing controls scroll.

Issue packages retain the exact, selected, validated model setup evidence.
Returned evidence must match the issued assets byte for byte. The operator
comparison shows each logo instruction before and after, including instruction-
only changes. No production schema, calibration authority or approval semantics
were changed.

OpenCode Contributor supplied the foundation and customer workspace changes;
Codex independently integrated, reviewed and refined the UI, added regression
coverage and performed the private garment walkthrough. No commits, external
uploads, customer sends or Odoo calls were part of this work.

Acceptance environment: macOS Darwin 27.2.0 arm64, bundled Chromium
156.0.8078.4 and installed Chrome 155.0.8059.85. Primary customer viewports were
1440×900 and 390×844; shared operator checks also include 1280×720. All browser
checks use built files over `file://` with networking disabled. Passing cases
assert zero HTTP(S) requests, page errors and console errors.

- `npm run typecheck`: pass.
- `npm test`: 861/861 pass.
- Customer model/editor/return/photo regression: 38/38 pass across Chromium
  and Chrome. This includes real mouse movement and resizing, shape locking,
  rejected out-of-area changes, cancellation and restored fields, zoom without
  physical changes, busy guards, draft/reopen, literal per-logo instructions,
  exact-revision confirmation, rejected altered mapping and operator adoption.
- Broader shared model/document/self-contained/station checks: 34 passed,
  four failed across the two browsers. The failures are the existing placement
  tray test and fresh-copied station journey; baseline checks use an unchanged
  `git archive HEAD` checkout and the same installed dependencies. These are
  retained failures, not skipped tests or a claim that the complete suite passes.
- An earlier full Chromium run was stopped after 39 passes, four failures and
  three interrupted tests; 183 cases did not run. Its customer control-visibility
  expectation was updated for the new disclosures. The three internal-builder
  failures also reproduce at the unchanged starting revision.

Run logs, screenshots, environment metadata and synthetic packages are under
`/tmp/logotool-customer-limited-ui-20261029/`; the unchanged baseline evidence is
under `/tmp/logotool-customer-proof-baseline-20261030/`. Final affected-path
smoke checks passed 14/14 and are recorded in `final-smoke.log` and
`final-smoke/`. Commands:

```sh
npx playwright test e2e/customer-model-proof.spec.ts e2e/customer-editor.spec.ts e2e/customer-return-review.spec.ts e2e/photo-mapping-workflow.spec.ts --project=chromium --project=chrome --workers=2
npx playwright test e2e/customer-model-proof.spec.ts e2e/unified-editor.spec.ts --project=chromium --project=chrome --workers=2
```

A separate private jacket/logo walkthrough covered issue, visual customer edits,
per-logo requests, confirmation, office comparison, adoption and saved reopen.
It uses local customer assets and a test-only reference span; it does not
establish real garment dimensions or production readiness. Real Windows
Chrome/Edge over `file://` remains the delivery release gate and was not run.
The mobile checks emulate a viewport on macOS, not a real touch device.


## Persisted model lighting — 2026-10-30

The unified 3D editor has a Lighting slider (25–300%) and Reset (100%).
Input previews immediately without reloading the model or moving the camera;
committed values are stored per model entry in `presentation/preview.json`.
Old projects default to 100%; invalid saved values safely use that default.
The setting follows setup, logo placement, save/reopen, issued customer proofs
and document rendering. Customer controls stay minimal. Lighting changes
invalidate derived document images, including when the physical revision is
unchanged. Original materials, GLB bytes, calibration and logo geometry are
not rewritten.

Independent acceptance: `npm run typecheck` passes; `npm test` passes 866/866.
Twenty offline browser cases across Chromium and Chrome cover lighting pixels,
unchanged camera/geometry, persistence, Reset, legacy defaults, customer handoff,
refreshed document images and existing model workflows. Two further cases verify
that lighting is available immediately after uncalibrated model intake. The
22 passing cases use synthetic fixtures over `file://`, networking disabled,
with zero HTTP(S), page errors or console errors.

Environment: Darwin 27.2.0 arm64, Chromium 156.0.8078.4, Chrome 155.0.8059.85;
1440×900 and 390×844. Logs and screenshots are local under
`/tmp/logotool-model-lighting-20261030/` (`unit-root.log`, `typecheck-final.log`,
`final.log`, `intake.log`). A private real-jacket visual and package comparison
also verified saved 300% lighting, identical original model bytes, unchanged
products/calibration, unchanged logo placements and unchanged physical revision.
Windows Chrome/Edge and actual mobile hardware remain untested.

```sh
npx playwright test e2e/model-lighting.spec.ts e2e/customer-model-proof.spec.ts e2e/model-document-workflow.spec.ts --project=chromium --project=chrome --workers=2
```

## Focus-this-area and customer area UX pass — 2026-11-02

Implemented camera-only **Focus this area** in the setup and shared placement /
customer model toolbars. Polygon points and winding-dependent normals are
resolved against the loaded mesh, including back areas. Missing, collinear,
nonfinite, remote or unavailable inputs refuse safely; active orbit-suspending
gestures cannot focus. Whole-product Fit remains available, and the zoom readout
reports the actual percentage against its Fit baseline. Setup focus stays
accessible after dismissing Areas; toolbar labels wrap without shrinking into
each other.

New customer placements show named area choices outside Advanced. Choices
preserve typed size and placement notes, use aria-pressed, and honor busy/drag
locks. Existing placements keep their original selectors; zero-area products
show an explicit empty state. Fit warnings use short guidance, with the exact
validator verdict in collapsed technical details. Geometry, confirmation rules,
production schemas and original assets were not changed.

OpenCode Contributor lead and two bounded workers handed off at 06:22 Amsterdam.
Codex independently reviewed the integrated diff and corrected focus visibility,
truthful zoom, collinear/remote input validation, normal transformation, draft
preservation and the unfinished synthetic specs. All delegated writers stopped;
no commits, pushes, Odoo calls, uploads or dependency changes were made.

Development environment: macOS 27.2 (26B123), arm64, Node 26.10.0,
Playwright 1.64.0, bundled Chromium 156.0.8078.4 and installed Chrome
156.0.8078.74. Every browser context used offline `file://`; test attachments
record each browser version, viewport and environment. Viewports include
1280×900, 1440×900/1000 and 390×844.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed all three configurations |
| `npm test` | Build and all 866 Node tests passed |
| Customer editor, customer model proof, setup calibration — Chromium | 40 passed |
| Same three files — installed Chrome, one worker | 39 passed; one browser-close failure |
| Chrome image-regeneration failure, isolated rerun | Passed |
| Final changed-feature checks, Chromium + Chrome | 14 passed (7 per browser) |
| `git diff --check` | Passed |

The Chrome broad run is **not** recorded as a clean full pass. An initial
parallel run had two browser-close failures; the single-worker run retained
one, with macOS display/GPU diagnostics. Its isolated rerun passed. The final
focused checks cover both viewport sizes, camera focus, draft preservation,
short warnings and shared customer placement focus. No retry setting or test
was weakened to hide the hiccup.

Private real-jacket acceptance (installed Chrome, offline, 1440×1000): Pocket
focus increased the projected six-corner bounds from about 67×65 to 343×328 px;
Fit returned them to about 80×76 px. Upper Back was visually inspected from the
back. Deterministic setup JSON was exactly equal before/after camera operations.
A fresh self-contained customer file retained the original model/artwork bytes,
product definitions and placements. All four area choices were selected outside
Advanced; the 390×844 page had no horizontal overflow. Zero page/console errors
and zero HTTP(S) requests were observed in these private checks.

A short 40-cycle focus/Fit sample left the project revision unchanged. After
explicit garbage collection, JS heap went from 6.77 to 7.24 MiB (+0.47 MiB),
with backing storage essentially unchanged. This is a bounded observation,
not proof of leak freedom; GPU memory and process RSS were not profiled here.
Private files, screenshots and logs remain outside the repository under
`/tmp/logotool-next-ux-20261102/`.

Actual Windows Chrome/Edge offline acceptance, Edge on this machine, actual
mobile hardware and the complete repository browser matrix remain untested.
These results are macOS development evidence, not the Windows delivery gate.

## Product inclusion and contextual controls — 7 November 2026

See the [follow-up audit](product-inclusion-followup-2026-11-07.md) and
[tracked evidence](validation/2026-11-07-priority-followup/) for the final-tree
acceptance results and case-by-case comparison with merged `c180a41`.
The original UX audit remains a historical record.

New offline specs cover excluded-product and excluded-option creation blocks,
queued stale Add callbacks, inclusion recovery and the issued ZIP's intended
placement, retained excluded placement editing, 1280×720 long hint/status
readability, keyboard overflow, and the 390×844 native tool picker and View panel.
Existing physical, document, confirmation and workspace size assertions remain.

A serial installed-Chrome comparison ran three baseline-available closure-prone
cases ten times on each of `e583941`, `c180a41` and a handler-off diagnostic copy.
All 90 passed with zero closures. This bounded experiment did not reproduce the
previous intermittent problem, whose cause remains unresolved.

Environment is macOS 27.3 (26C5035r), arm64, Node 26.10.0, Playwright 1.64.0,
Chromium 156.0.8078.4 and installed Chrome 156.0.8078.74. All acceptance uses
synthetic fixtures and offline `file://`. Actual Windows Chrome/Edge remains
untested and is the customer-delivery release gate.
