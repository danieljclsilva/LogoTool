# Customer and canvas follow-up evidence

Synthetic fixtures over offline `file://` on macOS 27.3.0 arm64, Node 26.10.0,
Playwright 1.64.0 and Chromium 156.0.8078.4. Two workers, zero retries.
The 48-case selection passes in Chromium and installed Chrome 156.0.8078.80
with no skips. Each acceptance flow checks zero
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
