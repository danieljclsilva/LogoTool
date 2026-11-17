# PR #6 review follow-up evidence

Synthetic fixtures over offline `file://` on macOS 27.3 (26C5035r), Darwin
27.3.0 arm64, Node 26.10.0 and Playwright 1.64.0. Chromium is 156.0.8078.4.
Installed Chrome is 157.0.8103.51. Every cohort uses zero retries and skips.
Each completed acceptance flow asserts zero page errors, console errors and
HTTP(S) requests. Browser and viewport metadata are retained per case.

## Changes and acceptance

View opens the existing navigation group on desktop and phone. Fit closes it
and returns keyboard focus to View. Opening Measure closes View, and opening
View closes the contextual authoring panel. The canvas retains its dimensions.
The new Fit regression reads the WebGL buffer and finds the synthetic blue
model's actual pixel bounds. It checks that all edges fit inside the canvas,
that View's trigger has zero intersection with the model bounds, and that the
navigation group is hidden. Desktop 1290×700 and phone 390×844 run in normal
and enlarged views. Keyboard Enter/Escape and 44 px targets remain checked.
The existing canvas test retains its actual 315 px floor, reachable footer
and exact product-geometry assertions.

Customer dimension text uses 15 significant digits while exact numeric backing
supplies unchanged form values. A regression covers linked edits, blur,
explicit independent sizing, small/high-precision dimensions, download, reopen
and an unrelated field edit. Stored dimensions retain strict numeric equality.
The replacement warning appears below the project chooser. Size and Keep shape
precede optional instructions. Missing-photo copy points customers to the diagram.

## Run history

| Cohort | Workers | Passed | Failed | Result |
| --- | --- | --- | --- | --- |
| Preliminary Chromium canvas/customer persistence | 2 | 13 | 0 | Before strengthened pixel threshold and reopened-field edit |
| Affected Chromium flows | 2 | 87 | 3 | Two baseline model-status failures and one helper targeting hidden Rotate |
| Chromium compatibility and repaired helper | 2 | 66 | 1 | Existing 768 px enlargement assertion |
| Installed Chrome affected customer/canvas/document flows | 1 | 31 | 1 | Browser closure during desktop audit teardown |
| Installed Chrome desktop audit recheck | 1 | 1 | 0 | Separate zero-retry run |

The helper now opens View before selecting Rotate. Document navigation callers
also reveal View after tool selection closes it. The compatibility cohort
passes all 13 canvas/customer persistence cases, all three workspace audits,
setup/calibration, both model-document capture/save/reopen flows and editor
regressions. The two model-status failures and tablet enlargement failure match
their assertion targets in the prior hosted `6444b89` cohort. Their failure
messages are retained in `results.json`. The initial helper failure is retained
with its passing follow-up.

All 13 canvas/customer persistence cases also pass in installed Chrome. The
desktop audit's failed teardown reports `browserContext.close` with a closed
browser. Browser stderr includes CVDisplayLink and invalid-mailbox diagnostics.
The same case passes its separate recheck. The recurring macOS Chrome closure
remains unresolved.

Typecheck and all 884 Node tests pass. The Browser connector's relay failed to
start, so repo-local Playwright supplied the project's primary acceptance checks.

## Retained artifacts

- `unobscured-model-1290-normal.png` and `unobscured-model-1290-enlarged.png` show the fitted desktop product and footer.
- `unobscured-model-390-normal.png` shows the complete fitted phone product.
- `customer-replacement-guard.png` shows the warning next to the project chooser.
- `customer-phone-full-page.png` shows size, Keep shape and optional instructions in order.
- `results.json` retains case-level outcomes, error messages, environment metadata and measured canvas/model/control rectangles.
- `tested-files.json` records the final candidate's runtime, test and built-package hashes. The preliminary and affected cohorts preceded the documented test-helper changes and final template whitespace cleanup.
- `sha256.json` records the retained image hashes. Screenshots come from the final Chromium compatibility cohort.

The earlier evidence folders remain historical records. The viewer still uses
continuous rendering. The [round-4 handoff](../../round4-windows-rendering-handoff.md)
sets out the Windows experiments and rendering prototype. Actual Windows
operator-machine acceptance and unaided trials remain pending. Use the
[blank observer sheets](../../unaided-trial-observer-sheets.md) for those trials.
