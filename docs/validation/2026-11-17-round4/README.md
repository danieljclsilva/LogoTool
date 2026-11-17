# Round-4 local development evidence

Synthetic offline `file://` on macOS 27.3 (26C5035r), Darwin 27.3.0 arm64,
Playwright 1.64.0, Node 26.10.0. Chromium 156.0.8078.4 and installed Chrome
157.0.8103.51 each pass all eight canvas/guidance/workspace-audit cases with
zero retries and skips. Chromium uses two workers, Chrome one. Both model
document capture/save/reopen flows also pass in the expanded Chromium cohort.
Typecheck and all 884 Node tests pass.

`fit-desktop.png` and `fit-phone.png` show Fit beside View with the menu closed.
The regression checks both targets at 44 px, full model pixel bounds inside the
canvas and zero intersection with both buttons, normally and enlarged. Phone
Prepare/header content extends the page vertically. The canvas retains the
complete fitted model and the existing scrolling/reachability checks. The
first two development cohorts caught phone picker clipping. The corrected
cohort checks the complete picker in view and preserves full option labels.

`local-idle-profile.json` contains one initial idle sample per screen. The opt-in
probe passes all three initial tests with one worker and no competing browser suite. The added
document-review lifecycle test also passes with one worker.
A subsequent control adds and verifies an actual GL draw, RAF cancellation and
a deliberate context loss. The staff viewer draws about 60 frames/s while its
canvas is hidden after returning to Prepare. Landing/empty Prepare have zero
RAF callbacks. Switching customer proof to the diagram stops its RAF loop.
Document review retains two drawing loops, including the hidden setup viewer
and an offscreen capture viewer. Opening the reframe dialog adds a third loop.
Closing it stops the new loop. Two open/close cycles leave two detached,
non-drawing contexts reachable during the sample. This sample
does not establish a context leak or the cause of Chrome closures.

The initial probe smoke run had two fixture-navigation timeouts. It targeted a
setup-only Back action while Logos was active and a diagram button hidden by
the calibrated proof. The corrected flow uses the main Prepare step and loads
the synthetic diagram package. Those failed smoke results are excluded from
performance comparisons. All passing acceptance flows assert zero page errors,
console errors and HTTP(S) requests. The supplementary Browser relay was
unreachable at `http://127.0.0.1:19988`; repo-local Playwright supplies the primary
acceptance evidence required by AGENTS.md.

A list-only run discovers all 289 cases from generated experiment sources.
An independent AST comparison verifies all 66 copied files retain non-timeout
syntax and fixture bytes, with timing sites inventoried. Arm settings reject
contradictory worker/budget values. The matrix records original and derived
hashes. The [handoff](../../round4-windows-rendering-handoff.md) fixes the decision
table before the hosted runs. Hosted experiment results are recorded on the PR.
Actual operator-machine acceptance and human trial results remain pending.
