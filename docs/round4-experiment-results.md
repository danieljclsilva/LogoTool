# Round-4 rendering experiment results

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
The follow-up narrows the selector while retaining its full labels and target
size. Focused hosted QA checks that correction separately.

C recovers eight A failures and adds ten different failures. Two-worker failure
membership continues to vary on identical source. Doubling budgets increases
waiting time while preserving the timeout cluster. One worker is the next
Windows CI control, with normal timeout budgets and strict failure checks.
The regular CI keeps its existing two Windows shards and uses one worker per
runner. Linux retains two workers. Its complete normal-entry-point run will be
recorded with the Edge confirmation below.

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

The frozen-source Edge confirmation and current-source focused layout QA are
running. The user has no staff available for formal trials at this phase.
The [observer sheet](unaided-trial-observer-sheets.md) now includes an author-led
solo rehearsal with synthetic files, actual OS/browser recording and a 60-minute
cap. Independent participant trials and a representative Windows operator
machine remain pending. The proposed four-of-five formative threshold applies
to the later participant round.
