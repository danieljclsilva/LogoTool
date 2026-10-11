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
- `placements-restore.spec.ts` — save/restore roundtrip incl. fresh context,
  forged recompute, atomic failures, stale lock/recovery, determinism.
- `placements-race.spec.ts` — `restoreBusy` locks and obsolete async reads
  stay inert (controlled file-read completion and state waits, no timed sleeps).
- `safe-area-regression.spec.ts` — rect + concave-with-exclusion verdicts,
  2D preview presence.
- `standalone.spec.ts` — asset replacement resets session/areas/placements;
  copied single HTML file (folder name with spaces, no siblings) ingests and
  runs offline. Portable stand-in until true ZIP/unzip customer-package
  acceptance exists.

## Failure artifacts and scope

Reports/screenshots land under the already-ignored `test-results/` and
`playwright-report/` — never committed. Only explicitly synthetic source
fixtures (`e2e/fixtures/*.json`) are tracked. Known limits: `msedge` needs a
real Edge install (absent on this development host); geometry assertions go through
the UI's own verdicts/export bytes while `tests-ts/` covers the core math;
browser contexts attach OS, browser version, viewport and offline evidence to
the HTML report. Desktop/mobile screenshots use per-test/project paths and
are attached to the report.
