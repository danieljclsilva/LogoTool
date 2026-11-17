# Round 4 handoff — Windows rendering experiments

Prepared on 17 November 2026 following the PR #6 review.

## Objective

Determine how viewer rendering, worker concurrency and timeout budgets contribute
to the hosted Windows failure cluster. Produce a measured render-on-demand
prototype and a reproducible decision about its next rollout step.

## Observed evidence

- `src/viewer/model-viewer.ts` schedules another animation frame, updates
  OrbitControls, calls `onFrame`, updates reference/marker presentation and calls
  `renderer.render` on every loop iteration. The loop begins in the constructor
  and ends at disposal. OrbitControls damping is enabled.
- `captureCleanView` also performs explicit renders with temporary layer and
  viewport changes. It uses capture tokens and generation checks to handle
  concurrent requests and model replacement.
- The recorded Windows renderer in run `43759532764` is
  `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`.
  Chrome is 156.0.8078.80 and Edge is 156.0.4314.58 on Windows 10.0.26100.
- That run executes 286 cases per browser. Linux has 272 passes / 14 failures,
  Windows Chrome 219 / 67 and Windows Edge 221 / 65, with zero skips and retries.
  First errors are timeouts in 60 Chrome and 59 Edge failures.
- Repeated identical-content cohorts changed failing case membership. The
  [tracked triage](windows-triage-2026-11-15.md) records those comparisons.
- Full tracing produced a 723,538,266-byte Linux artifact and three Windows job
  timeouts at 35 minutes. Primary CI uses the untraced profile. `E2E_TRACE=1`
  enables retained action/DOM failure traces with continuous screenshots disabled.

[Recorded hosted run](https://github.com/danieljclsilva/LogoTool/actions/runs/43759532764)

## Hypothesis and unresolved questions

Continuous software rendering may consume enough CPU/GPU time to delay input,
scrolling, model readiness and browser automation. The existing evidence supports
an experiment. Measure main-thread delay, renderer activity and action timings
to establish the contribution of each mechanism.

Questions include how many viewer instances render concurrently, how hidden
views behave, which timeouts occur during readiness versus input/scrolling,
and whether failures move between cases as runner load changes.

## Experiment 0 — idle viewers and contexts

Run the opt-in `E2E_PROFILE_ONLY=1` Playwright probe before the factor matrix,
on Linux Chromium and Windows Chrome/Edge. Opening/reopening the PR or a
manual workflow dispatch gates A–D on successful measurement collection.
Follow-up commits run the profile and focused Fit/layout checks. Repeat the
original complete run to reproduce the frozen factor comparison. Record landing/empty Prepare, model setup, Logos,
Prepare after setup, customer proof, diagram, review and repeated replacement.
Include staff document review and two open/close cycles of its reframe dialog.
Each screen settles for 1.5 seconds and is sampled for 4 seconds with one worker.

The test-only init script counts pending RAF requests and callback identities,
executions, GL clear passes, draw calls and RAF callbacks that drew to each
canvas. The latter measures rendered RAF frames per second. Multiple render
passes in one callback share a rendered-frame count. Explicit capture clears
outside RAF are recorded separately. A control verifies clear counting, RAF
cancellation and a deliberate context-loss event. The matrix runs without this
instrumentation so probe overhead is confined to Experiment 0.

Record long-task count/duration/support, CDP page task/script time, heap and DOM
node count. Classify every observed canvas by DOM connection, layout visibility
and viewport intersection. Identify simultaneous drawing and drawing by hidden
canvases. Log `webglcontextlost` and restoration events. Context/canvas handles
use WeakRef. Reachable non-lost contexts and detached canvases are observable
proxies for context lifetime. Garbage collection timing and renderer disposal
require lifecycle evidence before interpreting a count as a leak. The probe
neither forces garbage collection nor loses application contexts.

If a hidden viewer continues drawing, first prototype explicit hidden-viewer
suspension on a separate comparison SHA. Check visibility restoration, overlays,
resize and document capture before broader scheduler work. Compare context
counts over repeated replacements and document-editor open/close cycles. A
context-loss event or count increase needs a reproducible lifecycle trace before
attributing macOS Chrome closures to context exhaustion.

## Experiment 1 — concurrency and timing

Pin an immutable source SHA, synthetic fixtures, browser build, viewport, offline
mode, renderer settings and shard membership for each comparison. Record runner
image/version and browser/renderer metadata. The preflight now derives workers and timeout multiplier from the arm and
rejects contradictory settings. Use zero retries and retain every run, including
failures and interrupted cases.

Run the following arms for Windows Chrome, with an equivalent Linux control.
Then confirm the useful result in Windows Edge.

| Arm | Workers | Timeout policy |
| --- | --- | --- |
| A | 2 | Current policy |
| B | 1 | Current policy |
| C | 2 | Doubled experimental budgets |
| D | 1 | Doubled experimental budgets |

Arm D implements the suggested first diagnostic. Arms B and C separate the two
changed factors. Repeat complete arms on the same tracked content and compare
case-level errors, action duration distributions and runner metrics.

The existing one-worker command is runnable now after `npm ci` and `npm run build`.

```sh
npx playwright test --project=chrome --workers=1 --retries=0 --reporter=line,json,html
```

The opt-in runner copies the acceptance sources into ignored
`ci-evidence/experiment-source`, preserves fixture bytes and imports, and uses
the TypeScript AST to multiply explicit `timeout` options and test/default
action/navigation timeout setters. Config defaults for test and expect budgets
use the same multiplier. Fixed timers and `waitForTimeout` delays retain their
original values. All four arms execute the same generated code path, including
multiplier 1. Source and derived SHA-256 hashes and timing sites are retained in
`experiment-manifest.json`. The checked-in tests retain their original bytes.

Windows Chrome uses four fixed shards for every arm, Linux Chromium two.
Each job has a 60-minute ceiling. A timed-out job is an incomplete arm. Keep its
artifacts and report the cases that did not finish. Report source SHA, exact
browser/runner builds, shard membership and any between-arm version differences.

```sh
E2E_EXPERIMENT_ARM=D TEST_SHARD=1/4 node scripts/run-rendering-experiment.mjs chrome
```

A lower failure count is evidence consistent with resource pressure. Use the
separate factor arms and timing/renderer measurements to interpret the cause.

## Decision table fixed before the first comparison

Interpret improvement through case-level errors and action timings, with
repeated arms needed to assess the observed run-to-run variability. A single
lower failure total supports a follow-up experiment.

| Observation across A–D | Next action |
| --- | --- |
| B and D improve relative to A and C | Repeat single-worker arms and correlate page task time/long tasks with failures. Investigate concurrency pressure. |
| C and D improve relative to A and B | Examine which waits consume extra budget. Repeat to distinguish slow completion from unstable failures. |
| Only D improves | Repeat the worker × budget interaction and inspect slowest actions. |
| B improves and extra timeout adds little | Use one worker as the next comparison control and investigate rendering cost. |
| All arms have similar failures | Cluster shared assertion/readiness targets and inspect deterministic behavior. |
| Failure membership varies without a repeatable arm effect | Repeat complete arms with pinned versions and retained timing data. |
| An arm reaches its job limit or versions/shards differ materially | Report the comparison as incomplete or confounded and correct the experiment setup. |
| Experiment 0 shows hidden viewers drawing | Test hidden-viewer suspension first, including capture and reactivation. |
| Context counts grow or context loss recurs during lifecycle cycles | Trace creation/disposal and canvas replacement before changing context management. |

Use the first useful Windows Chrome result for a complete Edge confirmation
with matching worker/budget policy. Keep original test predicates, per-case
outcomes and every attempt in the report.

## Intermediate rendering arm — idle throttle

After the idle baseline, prototype a flag-controlled throttle alongside the
continuous control. A starting experimental policy is a 10 Hz cap after two
quiet seconds. Record this as a proposed setting and adjust from measured
latency and CPU data. Return immediately to active cadence for user input,
OrbitControls damping, resize, model/texture completion or overlay changes.
Audit which changes reset the quiet period. Check the last damping frame,
`onFrame`, marker/label settlement and explicit document captures. Compare
hidden-viewer suspension and idle throttle independently before combining them.

## Experiment 2 — render-on-demand prototype

Work on a separate `codex/` branch after the occlusion repair. Define an explicit
experimental viewer option for continuous and on-demand rendering. Use the
continuous mode as the compatibility control. Document option propagation into
internal, inspector and customer viewer entry points before implementation.

The prototype needs an inventory of rendering invalidations and a coalesced
single-frame scheduler.

- Start rendering after construction, model load/replacement and reset.
- Invalidate on orbit/pan/zoom, Fit/focus, side changes, resize and pixel-ratio
  changes. Continue updates while OrbitControls damping changes the view, then
  settle to an idle state with no scheduled rendering work.
- Invalidate on lighting, visibility, materials, wireframe, texture completion,
  reference markers, axes, safe areas, selections and artwork changes. Include
  asynchronous completions and stale-generation rejection.
- Run view-revision updates, `onFrame`, reference-label sizing and marker facing
  and sizing for each rendered frame. Verify overlay settlement after the last
  damping frame, including timers and late texture/model completion.
- Audit `captureCleanView` and other explicit capture paths. Force their requested
  output frame, restore layer/viewport/camera presentation and invalidate the
  restored live view. Exercise concurrent captures, model replacement and disposal.
- Audit disposal and context restoration. Check request coalescing, cancellation,
  active viewer replacement and model/document/customer lifecycle paths.

Use measured render counters, active RAF counts, CPU time and event-loop delay
in a focused synthetic harness. Include an idle interval, orbit with damping,
resize, geometry edits, lighting/visibility changes, late artwork loading and
clean document capture. Set numerical idle-work and latency targets from the
continuous-mode measurements before evaluating the prototype.

## Acceptance and deliverables

The lead assigns bounded file ownership and interface contracts before workers
start. Follow AGENTS.md and use the named Contributor model. Codex performs
independent integration review and commits approved changes.

Deliver the invalidation inventory, flag design, immutable comparison manifests,
per-case error/timing comparisons, renderer metadata, CPU/RAF measurements and
retained failure evidence. Explain partial runs and browser/runner version changes.

Run `npm run typecheck`, `npm test`, targeted offline interaction/overlay/capture
suites and the complete browser cohorts needed for the comparison. Check stored
millimetres, coordinate frames, calibration, geometry and package round trips.
Validate self-contained and hybrid customer flows over offline `file://` in
Windows Chrome and Edge. Include a representative operator machine for delivery
acceptance and retain the unaided trial records privately.

The rollout decision should state which hypotheses the evidence supports,
which failure clusters persist, and the remaining work for the next change.
