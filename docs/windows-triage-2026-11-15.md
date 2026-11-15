# Windows browser triage — 15 November 2026

The completed hosted run `43742294340` reports 17 Linux Chromium failures,
57 Windows Chrome failures and 60 Windows Edge failures across 276 cases per
browser, with zero retries and skips. Three new disabled-reason tests pass in
each browser. Each Windows browser ran two disjoint 138-case shards.
[Full run](https://github.com/danieljclsilva/LogoTool/actions/runs/43742294340)

## Case-level overlap

There are 47 cases failing in at least one Windows browser that passed on Linux.
Seven cases fail only in Edge relative to Chrome, and four fail only in Chrome
relative to Edge. Case-level overlap is necessary to investigate the net
difference of three failures. These observations come from one completed Windows
cohort.

The tracked [failure inventories](validation/2026-11-15-windows-triage/) preserve
case titles, locations, first error lines and hashes of full recorded errors.
They support repeated-run comparison. CI continues to report all failures.
An automatic expected-failure gate needs repeat evidence and error-signature
comparison so a new error inside an already failing case is detected.

## Repeat on identical tracked content

Run `43747000114` tests merge commit `3c7ebc9`, whose tracked tree is identical
to `5071f4a` from the first cohort. Linux repeats 259 passes and the same 17
failures. Chrome returns 229 passes and 47 failures, with ten newly failing
cases and twenty recovering. Edge returns 217 passes and 59 failures, with four
newly failing cases and five recovering. Every project runs all 276 cases, with
zero retries and skips. The [case-level comparison](validation/2026-11-15-windows-triage/repeat-comparison.json)
records each transition. [Repeat run](https://github.com/danieljclsilva/LogoTool/actions/runs/43747000114)

A zero-retry run still has nondeterministic failures. The per-platform inventories
remain observational while CI keeps its existing strict Windows result. A
case-name allowlist based on the first cohort would classify ten Chrome and four
Edge failures on identical content as newly introduced. The timeout cluster
needs diagnosis before an expected-failure gate can distinguish regressions.

## Confirmed EOL problem

`prepared-product-import.spec.ts` fails on Windows when comparing a golden
sidecar JSON byte-for-byte. The diff consists of expected CRLF versus actual LF.
The earlier hashed SVG failure was another checkout-conversion manifestation.
The repository now declares `* text=auto eol=lf`, with exact-byte exemptions for
the two hashed SVG assets. Golden assertions retain their original values.

## Timeouts dominate the additional Windows cases

Chrome has 35 case-level timeouts outside the Linux failure set, alongside four
boolean/byte equality failures and one screenshot timeout. Edge has 39 case-level
timeouts outside the Linux set, alongside four equality failures. This counts
first reported errors and does not establish their underlying cause.

Representative failures occur after controls resolve as visible and stable,
while Playwright scrolls them into view. Other timeouts occur during canvas
picking or editing. This supports collecting renderer and timing evidence before
changing readiness thresholds. The preflight now records WebGL support, renderer,
vendor and version. Focused opt-in traces support action timing and DOM
inspection. A software-renderer cause remains unconfirmed.

## Layout and path checks

Three Windows persistence-status tests fail their readable-bounds predicate at
1440, 768 and 390 px. The predicate checks both viewport bounds and scroll size.
It needs measured rectangles and client/scroll sizes to distinguish font metrics,
wrapping, fractional-pixel rounding and real clipping. The original assertions
remain active.

Entry helpers use `pathToFileURL(resolve(...))`, including copied customer and
station entry points. The hosted Windows offline preflights pass with zero page
errors, console errors and HTTP(S) requests. Current evidence does not establish
a path-construction cause for the additional failing cases.

## Next validation

Use the per-job summaries to inspect failing titles without downloading artifacts.
Compare repeated zero-retry cohorts with matching browser/runner versions and
worker counts. Confirm the golden-JSON fix on Windows. Investigate the timeout
cluster using measured renderer information and representative retained traces.
The observed inventories support triage. Operator-machine acceptance remains open.

## Tracing experiment on `2ed8386`

Run `43752138435` enabled full action, DOM and screenshot tracing. Linux completed
286 cases with 264 passes and 22 failures, and produced a 723,538,266-byte artifact.
Edge shard 1 completed 143 cases with 109 passes and 34 failures. The other three
Windows shards hit the 35-minute job limit. These results are a separate
instrumented cohort, with incomplete Windows totals.

Eight of nine customer persistence cases passed in the completed Edge shard.
The first case timed out in the initial file chooser before testing dirty state.
Linux phone geometry exposed a normal-view canvas shortfall of about half a
pixel and an enlarged-view shortfall after entering a drawing tool. The phone
checklist spacing and footer grid were refined while preserving the assertions.

The new summaries run successfully in the completed jobs and list failing cases.
Full tracing substantially increased observed runtime and artifact size. Primary
CI returns to its untraced setting. Focused developers can set `E2E_TRACE=1` to
retain action and DOM traces on failure, with continuous screenshot capture
disabled. A local smoke case verified the trace event/snapshot streams and zero
screencast frames. Renderer records identify SwiftShader on hosted Windows.
A retained import-readiness trace also contains ReadPixels GPU-stall warnings.
Those observations leave the underlying timeout cause unresolved.
