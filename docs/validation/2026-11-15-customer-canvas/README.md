# Customer and canvas follow-up evidence

Synthetic fixtures over offline `file://` on macOS 27.3.0 arm64, Node 26.10.0,
Playwright 1.64.0 and Chromium 156.0.8078.4. Two workers, zero retries.
The latest untraced Chromium cohort passes all 59 focused and compatibility
cases with CI=true, two workers and zero retries. The phone footer uses two
columns, with full labels and 44 px targets. A separate 1280×720 reachability
case also passes.
The two-worker Chrome cohort passes 47 of 49 cases, with two browser-closure
errors in staff persistence tests. A one-worker expanded Chrome cohort passes
58 of 59 cases, with one browser-closure error in the presentation handoff test.
The earlier 48-case Chrome cohort passed completely. The affected presentation case passes
a separate one-worker, zero-retry recheck. No run uses retries or skips.
Each acceptance flow checks zero
page errors, console errors and HTTP(S) requests. The Browser connector probe
failed because its paired browser extension was inactive. Repo-local Playwright
provides the primary acceptance evidence required by AGENTS.md.

- `canvas-space-1290x700-normal.png` shows the actual 315 px canvas and all four footer actions.
- `canvas-space-1290x700-enlarged.png` shows the enlarged canvas and footer.
- `phone-390-enlarged.png` shows the phone authoring layout after navigation.
- `customer-desktop-initial.png` shows width, height and Keep shape outside Advanced.
- `customer-phone-initial.png` and `customer-phone-full-page.png` preserve the initial phone viewport and the complete page.
- `customer-replacement-guard.png` shows the save, discard and keep-editing decision.

`results.json` records environment, totals and actual canvas/footer rectangles.
`sha256.json` records screenshot bytes. `tested-files.json` records runtime and
acceptance-source hashes. Prior screenshots in `2026-11-15-round2-review` remain
historical evidence for the findings. Hosted Windows results are linked on the
PR. Actual operator-machine and unaided staff/customer trials remain pending.

The final 14-case staff layout selection passes in installed Chrome with one
worker and zero retries after the phone-footer refinement.

The final line-height refinement passes 25 Chromium and 24 Chrome cases, with
one Chrome browser closure during phone-audit teardown. The affected case passes
a separate one-worker, zero-retry recheck. The full untraced hosted cohort on
`f526aa9` passes all ten new customer persistence/canvas cases in all three
browsers. Full totals and the subsequent font fix are recorded on the PR.
