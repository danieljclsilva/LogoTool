# Offline testing — asset inspector e2e suite

Maintained Playwright acceptance for the standalone inspector
(`dist/asset-inspector.html`, built by `npm run build`). The suite opens the
built file directly through `file://` (via `pathToFileURL`, no server), drives
it in offline browser contexts, and asserts zero console/page errors and zero
HTTP(S) requests on every spec.

This is the internal inspector harness only — not the customer package
milestone. True ZIP/unzip acceptance awaits customer packaging.

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
- `standalone.spec.ts` — asset replacement resets session/areas/placements;
  copied single HTML file (folder name with spaces, no siblings) ingests and
  runs offline. Portable stand-in until true ZIP/unzip customer-package
  acceptance exists.

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
fixtures (`e2e/fixtures/*.json`) are tracked. Known limits: `msedge` needs a
real Edge install (absent on this development host); geometry assertions go through
the UI's own verdicts/export bytes while `tests-ts/` covers the core math;
browser contexts attach OS, browser version, viewport and offline evidence to
the HTML report. Desktop/mobile screenshots use per-test/project paths and
are attached to the report.
