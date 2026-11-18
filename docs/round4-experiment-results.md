# Round-4 rendering experiment results

Completed 18 November 2026.

The first complete factor cohort uses immutable source
`2f18ccfafd79a72b63d4051823fd686707d6e2e6`. Each arm runs all 289 cases with
zero retries, skips and flaky classifications. Windows Chrome uses four fixed
shards per arm and Linux Chromium two. All original test/fixture hashes and
case memberships match across arms. Explicit test/assertion/action budgets
are scaled through generated AST copies. Fixed timers and predicates retain
their original semantics.

[Full factor run](https://github.com/danieljclsilva/LogoTool/actions/runs/44174017332)

## Worker and timeout comparison

| Platform | Arm | Workers | Budget multiplier | Passed | Failed | Action/test timeouts | Median case time | 95th percentile |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Windows Chrome | A | 2 | 1 | 229 | 60 | 52 | 2.75 s | 51.88 s |
| Windows Chrome | B | 1 | 1 | 275 | 14 | 7 | 1.96 s | 19.55 s |
| Windows Chrome | C | 2 | 2 | 227 | 62 | 52 | 3.76 s | 97.44 s |
| Windows Chrome | D | 1 | 2 | 275 | 14 | 7 | 2.05 s | 28.00 s |
| Linux Chromium | A | 2 | 1 | 274 | 15 | 7 | 1.98 s | 17.26 s |
| Linux Chromium | B | 1 | 1 | 274 | 15 | 7 | 1.21 s | 14.82 s |
| Linux Chromium | C | 2 | 2 | 274 | 15 | 7 | 2.00 s | 21.36 s |
| Linux Chromium | D | 1 | 2 | 274 | 15 | 7 | 1.36 s | 20.47 s |

B and D recover the same 46 Windows failures relative to A and introduce zero
new failures. Their remaining 14 titles are identical and match the prior
Linux baseline. All four Linux arms fail the same 15 titles. The additional
Linux failure is phone tool-picker clipping introduced by persistent Fit.
The final correction restores the 138 px selector and gives Fit and View
fixed 44 px slots. Final hosted screenshots show the complete Rotate model
label; the focused checks retain the model bounds and touch targets.

C recovers eight A failures and adds ten different failures. Two-worker failure
membership continues to vary on identical source. Doubling budgets increases
waiting time while preserving the timeout cluster. One worker is the next
Windows CI control, with normal timeout budgets and strict failure checks.
The regular CI keeps its existing two Windows shards and uses one worker per
runner. Linux retains two workers. The completed normal-entry-point run below
checks this policy on all three platforms.

These results support a concurrency contribution to Windows failures. The
hidden rendering measurements identify a plausible mechanism. A rendering
suspension/throttle intervention and repeated cohorts can measure how much of
the concurrency effect it explains. The viewer continues to render normally
in the shipped code in this PR.

## Idle rendering and context lifecycle

Experiment 0 passes all four tests on Linux Chromium, Windows Chrome and
Windows Edge, with one worker and zero retries/skips. All three preflights
identify ANGLE Vulkan SwiftShader. The tested browsers are Chromium
156.0.8078.4, Chrome 156.0.8078.80 and Edge 156.0.4314.58. Windows is
10.0.26100 with runner image 20261103.298.1.

The four-second settled samples show the following.

| State | Observed work |
| --- | --- |
| Staff landing and empty Prepare | Zero pending RAF callbacks |
| Staff model setup and Logos | One drawing loop at about 60 frames/s |
| Prepare after returning from setup | The hidden staff canvas continues drawing at about 60 frames/s |
| Document review | Two drawing loops, from the hidden setup canvas and the offscreen capture viewer |
| Document reframe dialog | A third drawing loop while the dialog is open |
| After two reframe open/close cycles | Two original loops remain; the closed dialog loops stop |
| Customer proof and review | One active drawing loop |
| Customer diagram after proof replacement | The proof RAF loop stops |

In the two dialog samples Chrome records 20–21 long tasks and about 16–17
rendered RAF frames/s per canvas. Edge records 15–16 long tasks and about
13 frames/s. Linux records 30 long tasks and about 26 frames/s. This is one
initial sample per state. Rendered-frame counts identify RAF callbacks issuing
GL draws. Clear passes and explicit renders outside RAF are retained separately.
CDP page task/script duration brackets the sampling commands and supplies timing
evidence. It does not measure operating-system CPU utilization directly.

No application context-loss events occur in these samples. Detached, non-drawing
contexts remain weakly reachable after dialog disposal. The probe uses WeakRef
and records DOM connection, viewport intersection and loss state. Garbage
collection timing and renderer lifecycle evidence are needed to interpret
retention as a leak. The control test deliberately loses its own context to
verify event recording.

## Environment limits and next intervention

Windows uses the same browser and runner image across all A–D shards. Linux C
shard 2 uses image 20261111.82.6 with kernel 7.0.0-1016-aws. The other Linux
shards use image 20261111.196.1 with kernel 7.0.0-1019-azure. Both report
`ubuntu26`. Linux C timing comparisons include this runner variation. Its
failing-title set still matches A, B and D.

The next rendering intervention is flag-controlled suspension of hidden staff
viewers and the offscreen document renderer while capture work is idle. Verify
reactivation, resize, overlays and explicit captures before measuring its
CPU/frame effects. Compare the proposed idle throttle independently. The
[handoff](round4-windows-rendering-handoff.md) records the decision table fixed
before these runs and the broader invalidation/capture requirements.

## Evidence and remaining acceptance

[Tracked measurements and screenshots](validation/2026-11-17-round4/README.md)
include all 2,312 factor case outcomes, summaries and the hosted profile data.
GitHub artifacts retain original/derived source manifests, browser/runner
metadata and failure evidence. The factor run finishes with a failure status
because all existing assertions remain active.

## Completed confirmation and final QA

The [frozen-source Edge confirmation](https://github.com/danieljclsilva/LogoTool/actions/runs/44186738066)
uses source `2f18ccf`, one worker, normal budgets and four shards. It completes
289 cases with 273 passes and 16 failures, zero skips/retries. Its failures
include the shared 14 and two document-review journeys. The front-only case
stalls after a stable Reframe button reaches the click action. The front/back
case's original failure is masked by its diagnostic screenshot timing out.
Both journeys pass in the later canonical cohort. Preserve this variability;
there is no document-renderer fix in this change.

The [final focused hosted QA](https://github.com/danieljclsilva/LogoTool/actions/runs/44189653246)
on `4b949eb` passes four profiling and eight Fit/guidance/workspace cases in
each of Linux Chromium, Windows Chrome and Windows Edge: 36 passes in total,
zero skips/retries. The final Linux phone screenshot shows the full tool label.
An earlier eight-case box-check cohort passed despite native caption clipping;
its screenshot is retained separately to document the limit of those assertions.

The [regular CI run](https://github.com/danieljclsilva/LogoTool/actions/runs/44189661462)
completes all 289 cases on each platform:

| Platform | Workers per runner | Shards | Passed | Failed | Skips / retries |
| --- | --- | --- | --- | --- | --- |
| Linux Chromium | 2 | 1 | 275 | 14 | 0 / 0 |
| Windows Chrome | 1 | 2 | 275 | 14 | 0 / 0 |
| Windows Edge | 1 | 2 | 275 | 14 | 0 / 0 |

All three failing-title sets exactly match frozen Windows arm B's 14 failures.
There are no new failures in this cohort. CI remains red: existing failures are
not allowlisted or skipped. The PR merge checkout `2c3e14e` and branch head
`4b949eb` have identical tree `c89e1c38df26d6bce3f281b8e14fab5c7b327cee`.
Subsequent evidence-only changes preserve the tested runtime and CI sources.
Duplicate CI runs for such report-only pushes may be cancelled; the completed
run above is the verification evidence.

On macOS 27.3, native Chrome 157.0.8103.51 identifies ANGLE Metal on Apple M1.
The four-profile cohort has three passes and one browser target closure while
opening a CDP session for the customer sample. The isolated customer recheck
passes without retries. No application context losses occur in collected
samples. Per-page counters cannot observe native contexts retained after a
page closes, so the recurring macOS closure remains unexplained.

## Improvised rehearsal and remaining acceptance

The user is improvising with available resources at this stage. The
[observer sheet](unaided-trial-observer-sheets.md) includes an author-led solo
rehearsal with synthetic files, actual OS/browser recording and a 60-minute cap.
A generated local `dist/dev/solo-walkthrough.zip` includes self-contained staff
and customer HTML, models, artwork, a prepared two-product job and instructions.
It is a development artifact; original assets and blank evidence remain tracked.

A fresh-unzip offline Chromium check accepts staff model/artwork imports,
retains linked 120 × 60 mm customer dimensions in the downloaded draft, blocks
adding to the excluded second product, and lists its existing placement as
omitted in Review. These flows record zero page/console errors and HTTP(S)
requests. This automated kit check is development evidence on macOS.

Independent participant trials and representative Windows operator-machine
acceptance remain pending. Solo rehearsal supplies no independent participant
completion count. The proposed four-of-five formative threshold applies to the
later participant round. Next implement and measure hidden/offscreen viewer
suspension, then triage the shared 14 failures with strict assertions retained.
