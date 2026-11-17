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

## Experiment 1 — concurrency and timing

Pin an immutable source SHA, synthetic fixtures, browser build, viewport, offline
mode, renderer settings and shard membership for each comparison. Record runner
image/version and browser/renderer metadata. The current preflight script records
`workers: 2` as a constant. Make its worker and experimental timeout metadata
reflect the actual arm before using it as the experiment manifest. Use zero retries and retain every
run, including failures and interrupted cases.

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

`--timeout=60000` doubles the current 30-second default test timeout only.
Several specs call `test.setTimeout`, helpers set action timeouts, assertions
have an expect timeout, and some waits specify their own timeout. Inventory
those categories before implementing arms C and D. Choose shard sizes and job
budgets that allow the single-worker, doubled-budget arm to complete, using the
same shard membership across all arms. Provide one explicit,
experimental multiplier through a shared test configuration/helper and record
which budgets it covers. Keep test predicates and production behavior as the
acceptance criteria. Report job-level budget limits and unfinished cases.

A lower failure count is evidence consistent with resource pressure. Use the
separate factor arms and timing/renderer measurements to interpret the cause.

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
