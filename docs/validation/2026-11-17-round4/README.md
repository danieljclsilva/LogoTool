# Round-4 evidence — completed 18 November 2026

The [results report](../../round4-experiment-results.md) interprets the measurements
and identifies remaining acceptance gaps. All fixtures and screenshots here are
synthetic. Browser acceptance uses offline `file://`; passing flows assert zero
page/console errors and HTTP(S) requests.

## Hosted cohorts

| Evidence | Source | Result |
| --- | --- | --- |
| `factor-cases.jsonl`, `factor-summary.json` | `2f18ccf` | All 2,312 outcomes from 8 × 289-case A–D arms. Windows Chrome failures 60/14/62/14; Linux Chromium 15 in every arm. |
| `hosted-idle-profiles.json` | `2f18ccf` | Four profile cases pass per browser: Linux Chromium, Windows Chrome, Windows Edge. |
| `edge-confirmation.json` | `2f18ccf` | Frozen Edge B: 273 passes / 16 failures, including two document journeys beyond the shared 14. |
| `hosted-ui-qa.json` | `17f5cf3` | Historical 8-case box checks pass per browser despite native Linux tool-label truncation. |
| `hosted-ui-qa-final.json` | `4b949eb` | Final 4 profile + 8 UI cases pass in each of three browsers. Full tool label visually checked. |
| `regular-ci.json` | `4b949eb` tree | 275 passes / 14 failures on each platform. Same 14 titles; no skips, retries or flaky classifications. |

Original source, generated AST manifests, runner/browser metadata and failure
artifacts remain attached to the linked Actions runs in the results report.
All factor arms have matching original test/fixture hashes and case membership.
Linux C shard 2 uses a different runner image/kernel from the other Linux
shards; timing comparisons include that variation. Final regular CI checks out
PR merge commit `2c3e14e`, whose tree exactly equals branch head `4b949eb`.
The JSON records both tree IDs and the comparison. Subsequent changes are
reports/evidence only. Strict CI still fails on the shared 14 cases.

## Screenshots

- `fit-phone-linux.png`: final hosted `4b949eb`, 390 × 844, normal view. Full
  Rotate model label, 44 px Fit/View, full fitted model.
- `fit-phone-linux-box-check.png`: historical hosted `17f5cf3`, same viewport.
  Box assertions pass but the native caption is visibly truncated. Retained as
  the before-image, not final acceptance.
- `fit-desktop.png`, `fit-phone.png`: initial local `2f18ccf` development views
  at 1290 × 700 and 390 × 844. Final focused checks cover both normal and
  enlarged views, fitted model pixel bounds, button non-intersection and footer
  reachability. Phone pages scroll while retaining the existing canvas floor.
- `sha256.json`: screenshot hashes.

## Local checks and limitations

Local environment: macOS 27.3 (26C5035r), Darwin 27.3.0 arm64, Node 26.10.0,
Playwright 1.64.0. Chromium 156.0.8078.4 passes all eight final
Fit/guidance/workspace cases. Installed Chrome 157.0.8103.51 passes the earlier
eight-case UI cohort with one worker. Both model-document capture/save/reopen
flows pass in Chromium. Typecheck and all 884 Node tests pass.

`local-idle-profile.json` retains the initial Chromium screen and document
lifecycle samples. `macos-chrome-profiles.json` records a later 3-pass / 1-closure
native Chrome profile cohort and a separate passing customer recheck. Native
Chrome reports ANGLE Metal on Apple M1; hosted browsers report SwiftShader.
The Mac closure occurs before the customer sample. Its cause remains unresolved.
Weakly reachable per-page contexts do not measure native driver contexts retained
after closed pages or prove a context leak.

The probe identifies a hidden staff canvas still drawing at roughly 60 fps,
two loops on document review and a third in the reframe dialog. Closing the
dialog stops its loop. Replacing customer proof with a diagram stops the proof
loop. The deliberate control context-loss event verifies event capture; no
application context losses occur in collected samples. CDP page task duration
is not OS CPU utilization. Shipping renderer behavior is unchanged.

A list-only experiment discovers all 289 cases. Independent AST comparison
checks 66 copied files and 98 timing sites, preserving non-timeout syntax and
fixture bytes. The initial probe smoke runs had two corrected fixture-navigation
timeouts; these are excluded from performance comparisons. The supplementary
Browser relay was unreachable at `http://127.0.0.1:19988`. Repo-local Playwright
provides the primary evidence required by AGENTS.md.

## Solo kit

`solo-kit-verification.json` records hashes and fresh-unzip local checks for the
ignored `dist/dev/solo-walkthrough.zip`. The kit includes standalone staff and
customer HTML, two models, a synthetic PNG, the prepared two-product job, model
sources, README, observer sheet and per-file manifest. It runs directly after
unzip without a server or runtime dependencies.

Verified offline Chromium flows import staff assets, download linked customer
120 × 60 mm dimensions, block adding to the excluded product and show its
existing placement as omitted. Zero page/console errors and HTTP(S) requests
are recorded. This is automated development evidence. Solo rehearsal results,
independent participant trials and actual Windows operator-machine acceptance
remain pending; the blank observer sheet does not imply completed trials.
