# UX validation audit — 7 November 2026

The published UX commit is `3bbff0dc571ac55482b5748a6e3114a216811997`, based on `e583941`. It was already pushed to `main` at the user’s explicit request before this follow-up review. Further repairs are isolated on `codex/ux-validation-followup`. This report replaces the stale 211-pass/41-failure readiness evidence; that earlier run is retained only as historical evidence.

The complete follow-up suite has **231 first-attempt passes, 27 failures and 0 retry recoveries**. The suite is not green. This branch is reviewable evidence and scoped repairs, not release approval.

## Review and repair plan

1. Freeze the original baseline and published commit in separate detached worktrees; run each complete Chromium suite in the same macOS environment with two workers and one retry. Keep their own tests unchanged.
2. Account for every failure from either run and all 41 historical failures. Distinguish shared failures, changed blocking mechanisms, added tests, flakiness and regressions.
3. Measure and capture normal/enlarged workspaces at the requested three viewports, including an active polygon toolbar. Review WI-7 approval and implementation, native unload behavior, repeated mode toggles and diagnostic preservation.
4. Repair demonstrated regressions, preserve physical assertions, then run the complete repaired suite plus focused installed Chrome checks. Commit follow-up evidence and repairs to the review branch only.

## Environment and scope

macOS 27.2 (26B123), arm64; Node 26.10.0; Playwright 1.64.0; bundled Chromium 156.0.8078.4; installed Google Chrome 156.0.8078.74. All acceptance uses synthetic fixtures and built HTML opened through `file://` in offline contexts. Passing cases enforce empty console/page-error and HTTP(S)-request probes. This is development evidence. Actual Windows Chrome/Edge, native print dialogs and physical product calibration remain open release gates; Edge is absent on this Mac.

## Original 66-check coverage

The 66 executions are **33 unique cases run once in Chromium and once in installed Chrome**, across five spec files. The published Chromium inventory has 252 cases in 45 specs, so the focused command omitted 219 cases and 40 entire specs. It was never a substitute for the whole suite.

| Spec | Published cases | Selected per browser | Omitted |
| --- | ---: | ---: | ---: |
| `calibration-areas.spec.ts` | 1 | 0 | 1 |
| `contextual-workspace.spec.ts` | 4 | 0 | 4 |
| `customer-editor.spec.ts` | 9 | 0 | 9 |
| `customer-model-proof.spec.ts` | 5 | 0 | 5 |
| `customer-return-review.spec.ts` | 3 | 0 | 3 |
| `editor-regressions.spec.ts` | 19 | 19 | 0 |
| `inspector-smoke.spec.ts` | 1 | 0 | 1 |
| `internal-builder.spec.ts` | 14 | 0 | 14 |
| `model-document-workflow.spec.ts` | 2 | 0 | 2 |
| `model-lighting.spec.ts` | 5 | 0 | 5 |
| `model-visibility-regression-b.spec.ts` | 4 | 0 | 4 |
| `multiview-builder.spec.ts` | 9 | 1 | 8 |
| `multiview-hardening.spec.ts` | 4 | 0 | 4 |
| `multiview-viewer.spec.ts` | 16 | 0 | 16 |
| `new-project.spec.ts` | 14 | 0 | 14 |
| `operation-document-assets.spec.ts` | 7 | 0 | 7 |
| `operation-document-preview.spec.ts` | 5 | 0 | 5 |
| `operation-sheet-print.spec.ts` | 4 | 0 | 4 |
| `operational-candidate-preview.spec.ts` | 8 | 0 | 8 |
| `operator-file-chooser.spec.ts` | 1 | 0 | 1 |
| `operator-workflow.spec.ts` | 7 | 0 | 7 |
| `photo-mapping-workflow.spec.ts` | 5 | 0 | 5 |
| `placement-ux-regression-a.spec.ts` | 1 | 0 | 1 |
| `placements-drag.spec.ts` | 11 | 0 | 11 |
| `placements-race.spec.ts` | 1 | 0 | 1 |
| `placements-restore.spec.ts` | 1 | 0 | 1 |
| `placements.spec.ts` | 1 | 0 | 1 |
| `prepared-product-import.spec.ts` | 4 | 0 | 4 |
| `presentation-assets.spec.ts` | 7 | 0 | 7 |
| `product-cards.spec.ts` | 1 | 0 | 1 |
| `product-photo-intake.spec.ts` | 4 | 1 | 3 |
| `product-workspace.spec.ts` | 4 | 4 | 0 |
| `project-package-inspector.spec.ts` | 3 | 0 | 3 |
| `safe-area-regression.spec.ts` | 1 | 0 | 1 |
| `self-contained-customer.spec.ts` | 6 | 0 | 6 |
| `setup-calibration.spec.ts` | 26 | 0 | 26 |
| `standalone.spec.ts` | 2 | 0 | 2 |
| `station-entry.spec.ts` | 3 | 0 | 3 |
| `station-ux.spec.ts` | 8 | 8 | 0 |
| `unified-editor.spec.ts` | 3 | 0 | 3 |
| `user-workflow.spec.ts` | 4 | 0 | 4 |
| `variant-transfer.spec.ts` | 10 | 0 | 10 |
| `visual-operation-dimensions.spec.ts` | 1 | 0 | 1 |
| `visual-placement.spec.ts` | 1 | 0 | 1 |
| `visual-product-setup.spec.ts` | 2 | 0 | 2 |

Exact selected case names (each ran in both browsers):

- `e2e/editor-regressions.spec.ts` — uncalibrated model remains visible through prepare entry at 1440×900
- `e2e/editor-regressions.spec.ts` — uncalibrated model remains visible through mode entry at 1440×900
- `e2e/editor-regressions.spec.ts` — normal editor keeps the page top and actions reachable at 1440×900
- `e2e/editor-regressions.spec.ts` — uncalibrated model remains visible through mode entry at 1440×781
- `e2e/editor-regressions.spec.ts` — uncalibrated model remains visible through prepare entry at 1440×781
- `e2e/editor-regressions.spec.ts` — normal editor keeps the page top and actions reachable at 1440×781
- `e2e/editor-regressions.spec.ts` — uncalibrated model remains visible through mode entry at 1280×720
- `e2e/editor-regressions.spec.ts` — uncalibrated model remains visible through prepare entry at 1280×720
- `e2e/editor-regressions.spec.ts` — normal editor keeps the page top and actions reachable at 1280×720
- `e2e/editor-regressions.spec.ts` — uncalibrated model remains visible through mode entry at 390×844
- `e2e/editor-regressions.spec.ts` — uncalibrated model remains visible through prepare entry at 390×844
- `e2e/editor-regressions.spec.ts` — normal editor keeps the page top and actions reachable at 390×844
- `e2e/editor-regressions.spec.ts` — switching tools during texture loading completes the same model load
- `e2e/editor-regressions.spec.ts` — Finish area is readable, aligned and clickable at 1440×781
- `e2e/editor-regressions.spec.ts` — Finish area is readable, aligned and clickable at 1280×720
- `e2e/editor-regressions.spec.ts` — Finish area is readable, aligned and clickable at 390×844
- `e2e/editor-regressions.spec.ts` — artwork popup wraps long logo cards without clipping at 1440×781
- `e2e/editor-regressions.spec.ts` — artwork popup wraps long logo cards without clipping at 390×844
- `e2e/editor-regressions.spec.ts` — uncalibrated area offers scale fitting then recompute and logo placement
- `e2e/multiview-builder.spec.ts` — over-budget presentation add is rejected and leaves prior state untouched
- `e2e/product-photo-intake.spec.ts` — station intake: named views, gating, single empty state, workspace focus
- `e2e/product-workspace.spec.ts` — product workspace: live outline, enlarged controls, artwork and physical movement (1280)
- `e2e/product-workspace.spec.ts` — product workspace: live outline, enlarged controls, artwork and physical movement (1440)
- `e2e/product-workspace.spec.ts` — product workspace: live outline, enlarged controls, artwork and physical movement (768)
- `e2e/product-workspace.spec.ts` — product workspace: live outline, enlarged controls, artwork and physical movement (390)
- `e2e/station-ux.spec.ts` — station UX: real close warnings for dirty and pending placement edits, clean close without prompt
- `e2e/station-ux.spec.ts` — station UX: readable persistence follows Save through download, edit and reopen at 1440
- `e2e/station-ux.spec.ts` — station UX: readable persistence follows Save through download, edit and reopen at 768
- `e2e/station-ux.spec.ts` — station UX: readable persistence follows Save through download, edit and reopen at 390
- `e2e/station-ux.spec.ts` — station UX: retains both staged modes and Add includes only images, releasing thumbnails
- `e2e/station-ux.spec.ts` — station UX: retains both staged modes and Add includes only model, releasing thumbnails
- `e2e/station-ux.spec.ts` — station UX: download failure shows a plain headline and escaped technical disclosure
- `e2e/station-ux.spec.ts` — station UX: invalid placement fields explain disabled Apply and recover without losing edits

Machine-readable manifests are in [the evidence directory](validation/2026-11-07-ux/).

## WI-7 approval and review

The handoff requires **Codex** approval: “Deliver the proposal first. Implement only after Codex approves.” Before delegated implementation, Codex inspected the Apply path, proposed inline errors with `aria-invalid`/`aria-describedby` and a disabled-Apply reason, and explicitly approved that proposal in the chat and implementation contract. The coordinating chat approval began: “For WI-7, I’ve reviewed the Apply path and approve inline field errors…” No separate human approval is claimed. The private implementation contract was in the temporary audit files and is no longer available on resumption; this approval account relies on the coordinating chat history.

Independent review found the selected-placement validator covers area, offered method, positive finite width/height, finite rotation and finite X/Y using the same rules as Apply. Invalid staged edits remain pending and continue blocking save/review; domain commits retain their own checks. The browser test verifies invalid width, accessible error linkage, disabled reason and recovery without losing edits. Separate synthetic pure-validator checks passed 23/23, covering empty/non-numeric/non-finite values, invalid sizes/area/method and valid zero rotation/negative coordinates. These pure checks do not claim DOM coverage for all seven fields.

## Close prompts, object URLs and diagnostics

- Real `beforeunload` dialogs are exercised with trusted user activation for dirty jobs and pending placement edits. Added real-close cases require **zero dialogs** after a fresh open, a completed download handoff and Discard changes through the New guard. Download initiation is still not proof the operating system wrote the file.
- Both intake modes undergo three cycles (six switches). Total `createObjectURL` and revoke counts must remain exactly unchanged during toggles; the thumbnail URL is retained and revoked exactly once when Add clears staging. This checks URL lifecycle, not total browser memory.
- The original full presentation-budget diagnostic is asserted inside the hidden technical details in the real UI. A synthetic error with markup verifies safe text rendering in a technical `pre`. Static AST comparison found all 22 distinct original reparse error literals (29 occurrences) preserved byte-for-byte. This is not runtime fault injection of every error branch.

## Canvas measurements

The 180px value is a defensive floor, not the typical measured height. Normal phone/tablet views still require page scrolling; the initial visible height is reported separately, without pretending the full CSS canvas is on screen. The repaired enlarged phone uses horizontally scrollable editing/lighting and camera/display rows with unchanged accessible names and 44px-high controls. Existing phone icon treatments for drawing, expand and product-file actions remain; camera and text actions retain their labels. Desktop authoring fields and actions share a stable row; camera/display actions scroll in its remaining space. Keyboard focus and browser scrolling must reach every enabled control. Drawing actions and Save setup stay available.

The original unchanged unified-editor assertions require the enlarged canvas to exceed 45% of viewport height at 1440×900, 1280×720 and 390×844. Those assertions remain intact. The published UX commit had relaxed the product-workspace size guards (60% normal to 35%, and enlarged greater than normal to a 180px floor). This follow-up restores the 60% normal minimum and enlarged-greater-than-normal guard at the original 1280/390 sizes. The added 1440 case also uses those guards; the added tablet compares enlarged height to the normal canvas’s actual visible intersection, because its normal CSS canvas extends below the viewport.

Idle and active two-point polygon states produced the same heights at each requested viewport. Heights below are CSS pixels, rounded to one decimal; “visible” means intersection with the initial viewport at scrollY=0.

| Viewport | Mode | Published canvas / initially visible | Repaired canvas / initially visible | Repaired toolbar height |
| --- | --- | ---: | ---: | ---: |
| 1440×900 | normal | 509.0 / 509.0 | 589.0 / 589.0 | 64 |
| 1440×900 | enlarged | 551.7 / 551.7 | 662.2 / 662.2 | 64 |
| 768×1024 | normal | 665.6 / 473.9 | 665.6 / 477.9 | 176 |
| 768×1024 | enlarged | 577.7 / 577.7 | 589.7 / 589.7 | 176 |
| 390×844 | normal | 394.0 / 91.1 | 394.0 / 95.1 | 272 |
| 390×844 | enlarged | 258.7 / 258.7 | 429.7 / 429.7 | 180 |

Screenshots show the initial viewport, including scroll requirements. The normal phone view exposes only about 95px of its 394px canvas initially; enlargement provides about 430px fully visible. This remains a limitation of the normal narrow layout, not a claim of full-viewport usability.

| Viewport | Published normal / enlarged | Repaired normal / enlarged |
| --- | --- | --- |
| 1440x900 | [normal](validation/2026-11-07-ux/published-1440x900-normal.png) / [enlarged](validation/2026-11-07-ux/published-1440x900-enlarged.png) | [normal](validation/2026-11-07-ux/repaired-1440x900-normal.png) / [enlarged](validation/2026-11-07-ux/repaired-1440x900-enlarged.png) |
| 768x1024 | [normal](validation/2026-11-07-ux/published-768x1024-normal.png) / [enlarged](validation/2026-11-07-ux/published-768x1024-enlarged.png) | [normal](validation/2026-11-07-ux/repaired-768x1024-normal.png) / [enlarged](validation/2026-11-07-ux/repaired-768x1024-enlarged.png) |
| 390x844 | [normal](validation/2026-11-07-ux/published-390x844-normal.png) / [enlarged](validation/2026-11-07-ux/published-390x844-enlarged.png) | [normal](validation/2026-11-07-ux/repaired-390x844-normal.png) / [enlarged](validation/2026-11-07-ux/repaired-390x844-enlarged.png) |

Full-page context for the normal [tablet](validation/2026-11-07-ux/repaired-768x1024-normal-full-page.png) and [phone](validation/2026-11-07-ux/repaired-390x844-normal-full-page.png) makes their below-viewport canvas and Save actions visible.

Active phone toolbar screenshots: [published](validation/2026-11-07-ux/published-390x844-enlarged-active.png), [repaired](validation/2026-11-07-ux/repaired-390x844-enlarged-active.png). Full idle/active measurements are tracked as JSON. Passing audit cases assert non-overlap, 44px control heights, reachable Save setup, no page-width overflow and keyboard/scroll reachability of every enabled control in the horizontal rows.

## Repairs and verification details

- Enlarged 1280×720 canvas was 323.7px against the original >324px assertion; enlarged 390×844 was 258.7px against >379.8px. Container spacing and two narrow horizontal control rows restore those original checks without reducing control heights or introducing opaque letter shortcuts. Final Chrome checks include the restored original size guards, the unchanged unified-editor 45% checks, and idle/active layout audits with every scroll-row control reachable.
- Native pointer capture proves the photo discrepancy: whole-pixel click rounding made the reference slope about 0.174° in the published layout. Its predicted rectangle width is 977.21mm, matching the displayed 977.2mm instead of 975mm. The matching pointer release retains fractional coordinates and a horizontal reference; repaired corners span 975.0×731.3mm (display rounding). The existing <1mm width/height assertions remain unchanged.
- A truly horizontal SVG line has zero geometric height despite its visible painted stroke. The setup test now checks the visible reference group plus nonzero stroke and line length, rather than requiring a spurious slope to satisfy Playwright’s bounding-box visibility. Layer hide/show checks remain.
- The enlarged phone aspect ratio exposed aliasing in the synthetic artwork test: a 24%-height cyan band projected to less than one screen pixel and produced zero pixels above the strict cyan threshold. An isolated balanced two-band fixture restores resolvable cyan/body pixels with the cyan centroid above the body. The fixture now uses equal bands and a 180×90mm logo, keeping both bands resolvable across the tested aspect ratios; orientation, real artwork visibility, physical movement, cancellation and package invariance assertions remain intact. This test-only correction is separate from production rendering changes.
- Intermediate repaired full runs were interrupted after further fixture/layout review invalidated them. On resumption, the temporary directory and final-run process were absent, so that run’s outcome is unavailable. None supplies a final count. The complete recovered-workspace run below is the final acceptance result. Early overlapping Chrome diagnostics also encountered browser-process closure; retries and later serial outcomes are reported explicitly below.

The subset-issue failure was investigated beyond its native baseline timeout. Replaying that workflow against the unchanged baseline UI/domain source with the published visible-panel navigation helpers reaches the same zero-placement assertion: authoring focus remains on the excluded second product, so its logo is omitted from the selected issue. This [supplemental evidence](validation/2026-11-07-ux/baseline-reachable-evidence.json) establishes the deeper behavior predates the UX patch; it does not replace the native baseline result or resolve the intended authoring-focus contract.


The mapped-photo workflow also needed a test setup correction after the physical-frame repair made its interior Y coordinate exactly zero. Refilling an already-zero input fires `input` without a subsequent browser `change`, leaving a pending edit that correctly blocks drag. The test now changes only different coordinates and requires disabled Apply before starting the committed drag; all original physical, revision, confirmation, export and round-trip assertions remain. Customer runtime code is unchanged.

## Complete suite results and environment continuity

The paired baseline and published runs used their own unchanged source and tests, the same macOS 27.2 environment, two workers and one retry. Their saved attempt statuses and errors survive in the comparison artifact. On resumption, the private temporary worktrees/logs and final-run process were absent, and the OS had changed. The recovered workspace was rebuilt and retested on **macOS 27.3 (26C5035r), arm64**. Node and browser versions are unchanged. The final follow-up therefore is **not an identical-OS comparison** with those paired runs; that limitation is explicit. No result from the lost run is inferred.

| Snapshot | Cases | First-attempt passes | Failed after retry | Retry recoveries | Skipped | Minutes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline e583941 | 242 | 196 | 46 | 0 | 0 | 71.3 |
| Published 3bbff0d | 252 | 222 | 30 | 0 | 0 | 24.4 |
| Follow-up final tree | 258 | 231 | 27 | 0 | 0 | 24.7 |

Final recovered-workspace commands: `npm run typecheck`; `npm test` (build plus **866/866 Node tests**, zero failures/skips); then `npx playwright test --project=chromium --workers=2 --retries=1 --reporter=line,json` with a private output directory and `PLAYWRIGHT_JSON_OUTPUT_FILE`. Source and test SHA-256 hashes are recorded in `final-tested-files.json` and checked unchanged against the completed run. All contexts load `file://` offline; passing cases have empty console/page-error and HTTP(S) probes. Browser fallback was explicitly allowed by project instructions after the supplementary in-app browser rejected file URLs.

The retained macOS 27.2 Chrome evidence has 42 first-attempt passes and two retry recoveries out of 44, with no final failures/skips. The recoveries were the uncalibrated-area scale-fitting case and the dirty/pending native-close case, both reporting browser/context closure; their isolated trace-enabled rerun passed first attempt. The closure cause is unresolved. This is not a clean first-attempt pass or Windows evidence. New macOS 27.3 Chrome results are recorded separately below.

## Per-test comparison

The table includes all **41 historical failures**, every failure from the two complete paired runs, and the intermediate mapped-photo fixture failure even though it passes in both paired runs. “Shared” means both native runs failed, not that every later execution path or cause is identical. Six shared cases reached a different blocker after visible-panel navigation changed. The JSON contains exact errors and final attempts; the CSV is suitable for sorting. Baseline-only timeouts do not establish a production fix. Focus/selection contracts, legacy test navigation and diagnostic wording remain unresolved where stated.

[Full JSON comparison](validation/2026-11-07-ux/full-suite-comparison.json) · [CSV](validation/2026-11-07-ux/full-suite-comparison.csv) · [Final Chromium case results](validation/2026-11-07-ux/final-chromium-results.json)

| ID / test | Baseline | Published | Follow-up | Observed cause / limitation |
| --- | --- | --- | --- | --- |
| F01 · `editor-regressions.spec.ts` — Finish area is readable, aligned and clickable at 1280×720 | Pass (passed) | Pass (passed) | Pass (passed) | Historical toolbar rows differed in top alignment by 2px; published correction aligns 44px control boxes. |
| F02 · `editor-regressions.spec.ts` — Finish area is readable, aligned and clickable at 1440×781 | Pass (passed) | Pass (passed) | Pass (passed) | Historical toolbar rows differed in top alignment by 2px; published correction aligns 44px control boxes. |
| F03 · `editor-regressions.spec.ts` — Finish area is readable, aligned and clickable at 390×844 | Pass (passed) | Pass (passed) | Pass (passed) | Historical toolbar rows differed in top alignment by 2px; published correction aligns 44px control boxes. |
| F04 · `editor-regressions.spec.ts` — normal editor keeps the page top and actions reachable at 1280×720 | Pass (passed) | Pass (passed) | Pass (passed) | Historical enlarged-controls layout pushed Save setup below the viewport; published final layout correction makes this pass. |
| F05 · `editor-regressions.spec.ts` — normal editor keeps the page top and actions reachable at 1440×781 | Pass (passed) | Pass (passed) | Pass (passed) | Historical enlarged-controls layout pushed Save setup below the viewport; published final layout correction makes this pass. |
| F06 · `editor-regressions.spec.ts` — normal editor keeps the page top and actions reachable at 1440×900 | Pass (passed) | Pass (passed) | Pass (passed) | Historical enlarged-controls layout pushed Save setup below the viewport; published final layout correction makes this pass. |
| F07 · `internal-builder.spec.ts` — checking a prepared product and variant includes its setups without opening specific setups | Fail (timeout → timeout) | Pass (passed) | Pass (passed) | Add logo placement is inside the closed Artwork & logos panel; direct click times out. Published/final outcomes shown separately; absence here does not prove a production fix. |
| F08 · `internal-builder.spec.ts` — clears generated outputs and the baseline when a different source loads | Fail (timeout → timeout) | Pass (passed) | Pass (passed) | Add logo placement is inside the closed Artwork & logos panel; direct click times out. Published/final outcomes shown separately; absence here does not prove a production fix. |
| F09 · `internal-builder.spec.ts` — fractional millimetres render rounded once in staff return comparisons | Fail (timeout → timeout) | Pass (passed) | Pass (passed) | Add logo placement is inside the closed Artwork & logos panel; direct click times out. Published/final outcomes shown separately; absence here does not prove a production fix. |
| F10 · `internal-builder.spec.ts` — generation locks inputs, rejects obsolete hashing and recovers from hash failures | Fail (timeout → timeout) | Pass (passed) | Pass (passed) | Add logo placement is inside the closed Artwork & logos panel; direct click times out. Published/final outcomes shown separately; absence here does not prove a production fix. |
| F11 · `internal-builder.spec.ts` — guided preparation flows from open to deliberate selection to details | Fail (failed → failed) | Pass (passed) | Pass (passed) | Test expects Set logo placements; baseline button says Edit product. Published/final outcomes shown separately; absence here does not prove a production fix. |
| F12 · `internal-builder.spec.ts` — issues a subset hybrid package at revision 1 with approvals cleared | Fail (timeout → timeout) | Fail (failed → failed) | Fail (failed → failed) | Baseline: Add logo placement is inside the closed Artwork & logos panel; direct click times out. Published/follow-up: Test adds a logo while authoring focus remains on the excluded second product; issued subset has zero placements. Supplemental baseline UI replay with visible-panel navigation helpers reproduces the same zero-placement assertion. This source behavior predates the UX patch. |
| F13 · `internal-builder.spec.ts` — issues self-contained HTML that opens standalone and auto-loads the project | Fail (timeout → timeout) | Pass (passed) | Pass (passed) | Add logo placement is inside the closed Artwork & logos panel; direct click times out. Published/final outcomes shown separately; absence here does not prove a production fix. |
| F14 · `internal-builder.spec.ts` — keeps the automatic project ID stable and regenerates deterministic delivery bytes | Fail (timeout → timeout) | Pass (passed) | Pass (passed) | Add logo placement is inside the closed Artwork & logos panel; direct click times out. Published/final outcomes shown separately; absence here does not prove a production fix. |
| F15 · `internal-builder.spec.ts` — saves two files, opens the customer file, and reviews the return against the office copy | Fail (timeout → timeout) | Pass (passed) | Pass (passed) | Add logo placement is inside the closed Artwork & logos panel; direct click times out. Published/final outcomes shown separately; absence here does not prove a production fix. |
| F16 · `internal-builder.spec.ts` — staff journey needs no technical settings (1536px) | Fail (timeout → timeout) | Pass (passed) | Pass (passed) | Add logo placement is inside the closed Artwork & logos panel; direct click times out. Published/final outcomes shown separately; absence here does not prove a production fix. |
| F17 · `internal-builder.spec.ts` — staff journey needs no technical settings (390px) | Fail (timeout → timeout) | Pass (passed) | Pass (passed) | Add logo placement is inside the closed Artwork & logos panel; direct click times out. Published/final outcomes shown separately; absence here does not prove a production fix. |
| F18 · `multiview-builder.spec.ts` — over-budget presentation add is rejected and leaves prior state untouched | Pass (passed) | Pass (passed) | Pass (passed) | Historical test still expected 32-entry budget in the headline. Updated test checks the plain headline and the exact original diagnostic inside technical details. |
| F19 · `multiview-viewer.spec.ts` — model-only package offers honest 3D with a rendered model and side-tab availability | Fail (failed → failed) | Fail (failed → failed) | Fail (failed → failed) | Assertion expects the internal presentation/model.glb path in availability text; UI supplies a plain availability explanation. |
| F20 · `multiview-viewer.spec.ts` — replacement model bytes and an intervening image proxy keep the honest 3D pane current | Fail (failed → failed) | Fail (failed → failed) | Fail (failed → failed) | Assertion expects the internal presentation/model.glb path in availability text; UI supplies a plain availability explanation. |
| F21 · `new-project.spec.ts` — create customer journey adds a new raster logo and reviews the return | Fail (timeout → timeout) | Fail (timeout → timeout) | Fail (timedOut → timedOut) | Customer width-mm input stays hidden; trace ends in fill(60) without selecting/revealing a placement. |
| F22 · `new-project.spec.ts` — create starts a truly empty draft with no demo UI | Fail (failed → failed) | Pass (passed) | Pass (passed) | Test expects Set logo placements; baseline button says Edit product. Published/final outcomes shown separately; absence here does not prove a production fix. |
| F23 · `new-project.spec.ts` — create supports zero logos and distinct duplicate logo filenames | Fail (timeout → timeout) | Pass (passed) | Pass (passed) | Add logo placement is inside the closed Artwork & logos panel; direct click times out. Published/final outcomes shown separately; absence here does not prove a production fix. |
| F24 · `operation-sheet-print.spec.ts` — department-authored sheet prints one A4 page with operator data | Fail (timeout → timeout) | Pass (passed) | Pass (passed) | Add logo placement is inside the closed Artwork & logos panel; direct click times out. Published/final outcomes shown separately; absence here does not prove a production fix. |
| F25 · `operation-sheet-print.spec.ts` — fully configured two-view sheet prints complete with no unfinished items | Fail (timeout → timeout) | Pass (passed) | Pass (passed) | Add logo placement is inside the closed Artwork & logos panel; direct click times out. Published/final outcomes shown separately; absence here does not prove a production fix. |
| F26 · `operation-sheet-print.spec.ts` — operation sheet stays readable on a narrow viewport without horizontal overflow | Fail (timeout → timeout) | Pass (passed) | Pass (passed) | Add logo placement is inside the closed Artwork & logos panel; direct click times out. Published/final outcomes shown separately; absence here does not prove a production fix. |
| F27 · `operation-sheet-print.spec.ts` — two dimensions on the same logo print, measure and export together | Fail (timeout → timeout) | Pass (passed) | Pass (passed) | Add logo placement is inside the closed Artwork & logos panel; direct click times out. Published/final outcomes shown separately; absence here does not prove a production fix. |
| F28 · `operator-workflow.spec.ts` — artwork selection: add choices selected-only, excluded-used stays resolvable | Fail (failed → failed) | Pass (passed) | Pass (passed) | Add logo placement is inside the closed Artwork & logos panel; direct click times out. Published/final outcomes shown separately; absence here does not prove a production fix. |
| F29 · `operator-workflow.spec.ts` — calibrated photo overlay tracks canonical dimensions; unmapped views stay diagram | Fail (failed → failed) | Fail (failed → failed) | Fail (failed → failed) | Two expected legacy pw-view-tab controls are absent in the shared workspace; contract/feature gap remains unresolved. |
| F30 · `operator-workflow.spec.ts` — direct images job: intake, setup, placements, measurement, technique, review, save, reopen | Fail (failed → failed) | Fail (failed → failed) | Fail (failed → failed) | Baseline: Add logo placement is inside the closed Artwork & logos panel; direct click times out. Published/follow-up: Expected crest placement is absent in the active option. Product/option focus and inclusion interaction remains unresolved. |
| F31 · `operator-workflow.spec.ts` — direct model-only job: calibrated diagram placement without any photo | Fail (failed → failed) | Fail (failed → failed) | Fail (failed → failed) | Test clicks ref-pick-a while its Measure context panel is closed. |
| F32 · `operator-workflow.spec.ts` — invalid footprint stays scoped: actionable issue, complete print blocked, draft marked | Fail (failed → failed) | Fail (failed → failed) | Fail (failed → failed) | Baseline: Add logo placement is inside the closed Artwork & logos panel; direct click times out. Published/follow-up: Test clicks a placement row after review navigation while the placement workspace is hidden. |
| F33 · `operator-workflow.spec.ts` — primary span calibration drives the photo overlay with no Advanced mapping | Fail (failed → failed) | Fail (failed → failed) | Fail (failed → failed) | Test waits for the obsolete Finish safe area action in the photo workflow. |
| F34 · `operator-workflow.spec.ts` — zero-placement option stays present and prints its explicit statement | Fail (failed → failed) | Fail (failed → failed) | Fail (failed → failed) | Test expects the product card after Add has automatically opened the editor; it has not returned to Prepare. |
| F35 · `photo-mapping-workflow.spec.ts` — operator maps a photo, issues it, and the customer proves placement on the mapped photo | Pass (passed) | Pass (passed) | Pass (passed) | Intermediate follow-up run re-filled an already-zero Y coordinate, firing input without a browser change event and leaving the numeric form pending; drag is intentionally blocked. Setup now changes only different coordinates and asserts Apply is disabled before dragging. Original physical/revision/round-trip assertions remain. Customer code is unchanged; corrected workflow passes in Chromium and Chrome. |
| F36 · `placement-ux-regression-a.spec.ts` — placement UX: tray provisional preview, unified lock, unblocked drag (1280x900) | Fail (timeout → timeout) | Fail (timeout → timeout) | Fail (timedOut → timedOut) | Trace ends clicking ref-pick-a with Measure closed; timeout masks the hidden context control. |
| F37 · `placements-restore.spec.ts` — placement restore: roundtrip, forged recompute, atomic, stale lock | Fail (timeout → timeout) | Pass (passed) | Pass (passed) | Test timeout of 30000ms exceeded. Separate unchanged baseline diagnostic passed; timing cause unresolved. Published/final outcomes shown separately; absence here does not prove a production fix. |
| F38 · `prepared-product-import.spec.ts` — baseline review of the prepared-product return yields a consistent candidate | Fail (failed → failed) | Fail (failed → failed) | Fail (failed → failed) | Assertion expects Fits: no; actual geometry verdict says the logo extends beyond Chest and explains recovery. |
| F39 · `prepared-product-import.spec.ts` — customer places in the prepared mm region, confirms, saves and reopens | Fail (failed → failed) | Fail (failed → failed) | Fail (failed → failed) | Assertion expects Fits: no; actual geometry verdict says the logo extends beyond Chest and explains recovery. |
| F40 · `presentation-assets.spec.ts` — Builder prunes unselected reference images and preserves the selected image through delivery and return | Fail (timeout → timeout) | Fail (timeout → timeout) | Fail (timedOut → timedOut) | Trace ends filling hidden customer width-mm(60) without revealing the placement details. |
| F41 · `presentation-assets.spec.ts` — fixed product, artwork, area and method do not become redundant selectors | Fail (failed → failed) | Fail (failed → failed) | Fail (failed → failed) | Customer width-mm field is hidden without an active placement/visible details context. |
| F42 · `presentation-assets.spec.ts` — guided primary actions create zero and repeated placements without duplicates | Fail (timeout → timeout) | Fail (timeout → timeout) | Fail (timedOut → timedOut) | Trace ends filling hidden customer width-mm(40) without revealing the placement details. |
| F43 · `product-cards.spec.ts` — product cards: thumbnails, independent open, single-option default, narrowed subset | Fail (timeout → timeout) | Fail (timeout → timeout) | Fail (timedOut → timedOut) | Baseline: CARD-SOLO checkbox is hidden after the prepared file opens the editor automatically. Published/follow-up: Trace ends expecting workspace-product=CARD-MULTI after opening Multi Jacket; product focus remains unresolved. |
| F44 · `product-photo-intake.spec.ts` — five named views calibrate, save, reopen, issue, customer places, review agrees | Fail (failed → failed) | Fail (failed → failed) | Fail (failed → failed) | Existing-view rename input is hidden inside the unopened product files/details context. |
| F45 · `product-photo-intake.spec.ts` — in-place named rows: legacy views keep working, slug views at byte level | Fail (failed → failed) | Fail (failed → failed) | Fail (failed → failed) | Open photo-properties context intercepts a click on the Front view tab. Test navigation does not dismiss the overlay. |
| F46 · `product-photo-intake.spec.ts` — station intake: named views, gating, single empty state, workspace focus | Pass (passed) | Pass (passed) | Pass (passed) | Historical test still expected dismissing a destructive mode-switch confirm to keep the prior mode. Updated test checks retained staging without a confirm. |
| F47 · `product-workspace.spec.ts` — product workspace: live outline, enlarged controls, artwork and physical movement (1280) | Pass (passed) | Pass (passed) | Pass (passed) | Historical enlarged canvas was shorter than the normal CSS canvas. Published tests relaxed this guard. Follow-up restores original size guards at the original viewports; the added tablet compares visible space, with full measurements disclosed. |
| F48 · `product-workspace.spec.ts` — product workspace: live outline, enlarged controls, artwork and physical movement (390) | Pass (passed) | Pass (passed) | Pass (passed) | Historical enlarged canvas was shorter than the normal CSS canvas. Published tests relaxed this guard. Follow-up restores original size guards at the original viewports; the added tablet compares visible space, with full measurements disclosed. |
| F49 · `product-workspace.spec.ts` — product workspace: live outline, enlarged controls, artwork and physical movement (768) | Not in suite | Pass (passed) | Pass (passed) | Historical enlarged canvas was shorter than the normal CSS canvas. Published tests relaxed this guard. Follow-up restores original size guards at the original viewports; the added tablet compares visible space, with full measurements disclosed. |
| F50 · `setup-calibration.spec.ts` — product-setup tools: dotted reference, rectangle to independent polygon, edge insertion, rollback, zoom, visibility, point drawing | Pass (passed) | Fail (failed → failed) | Pass (passed) | Confirmed regression: whole-pixel click rounding tilts the reference frame and produces width 977.2mm versus expected 975±1mm. Repaired using matching fractional pointer release. |
| F51 · `station-entry.spec.ts` — fresh-copied station issues both customer formats offline with no repo dependency | Fail (timeout → timeout) | Fail (timeout → timeout) | Fail (timedOut → timedOut) | Baseline: Legacy pw-product-select control is absent from the shared editor. Published/follow-up: Trace ends after job-to-placements while waiting for the placements host to become visible; entry/focus state remains unresolved. |
| F52 · `unified-editor.spec.ts` — one editing workspace preserves canvas, areas and logos at 1280×720 | Pass (passed) | Fail (failed → failed) | Pass (passed) | Confirmed regression: enlarged canvas 323.7px fails the unchanged >324px requirement. Repaired spacing; original assertion retained. |
| F53 · `unified-editor.spec.ts` — one editing workspace preserves canvas, areas and logos at 390×844 | Pass (passed) | Fail (failed → failed) | Pass (passed) | Confirmed regression: enlarged canvas 258.7px fails the unchanged >379.8px requirement. Repaired narrow control rows; original assertion retained. |
| F54 · `user-workflow.spec.ts` — whole-workflow journey from a fresh station copy (hybrid customer file) | Fail (failed → failed) | Fail (failed → failed) | Fail (failed → failed) | Assertion expects Fits: no; actual geometry verdict says the logo extends beyond Chest and explains recovery. |
| F55 · `user-workflow.spec.ts` — whole-workflow journey from a fresh station copy (self customer file) | Fail (failed → failed) | Fail (failed → failed) | Fail (failed → failed) | Assertion expects Fits: no; actual geometry verdict says the logo extends beyond Chest and explains recovery. |
| F56 · `user-workflow.spec.ts` — whole-workflow journey through the hybrid ZIP customer file | Fail (failed → failed) | Fail (failed → failed) | Fail (failed → failed) | Assertion expects Fits: no; actual geometry verdict says the logo extends beyond Chest and explains recovery. |
| F57 · `user-workflow.spec.ts` — whole-workflow journey through the self-contained customer file | Fail (failed → failed) | Fail (failed → failed) | Fail (failed → failed) | Assertion expects Fits: no; actual geometry verdict says the logo extends beyond Chest and explains recovery. |
| F58 · `visual-operation-dimensions.spec.ts` — four select-based measurements across two logos print and export | Fail (timeout → timeout) | Fail (timeout → timeout) | Fail (timedOut → timedOut) | Baseline: Add logo placement is inside the closed Artwork & logos panel; direct click times out. Published/follow-up: Trace ends clicking the crest placement row while the active scope has no matching visible row; focus/selection issue remains unresolved. |
| F59 · `visual-placement.spec.ts` — visual placement: photo/diagram handles move, resize, rotate, cancel, siblings | Fail (timeout → timeout) | Pass (passed) | Pass (passed) | Add logo placement is inside the closed Artwork & logos panel; direct click times out. Published/final outcomes shown separately; absence here does not prove a production fix. |
| F60 · `visual-product-setup.spec.ts` — shared region: one safe-area edit reaches both variants, anchors stay per-variant | Fail (failed → failed) | Fail (failed → failed) | Fail (failed → failed) | Expected Safe area (4) action is absent in the current named-area workflow. |
| F61 · `visual-product-setup.spec.ts` — visual setup: upload → guided measure → draw + anchors → save → job roundtrip → review | Fail (failed → failed) | Fail (failed → failed) | Fail (failed → failed) | Initial workspace-status text is empty rather than the expected No product yet wording. |

## Readiness and remaining gates

The three demonstrated baseline-pass/published-fail regressions are the reference-span precision case and the 1280×720/390×844 unified-editor canvas cases; their final outcomes are listed above. The full suite still has workflow failures, including unresolved product focus/inclusion, hidden legacy controls and wording/availability contracts. They are not waived, and shared failure does not prove identical cause. Normal phone/tablet layouts retain page-scroll limitations. No core/schema, production export, packaging, dependency, original asset or Odoo changes were made.

This follow-up is intended for `codex/ux-validation-followup`; no further main push is part of this review. Actual Windows Chrome/Edge offline delivery, missing local Edge, native print dialogs and physical calibration remain open. The public demo's deployed artifact was not independently verified.

Recovered-workspace installed-Chrome selection (macOS 27.3, serial worker, one retry): **43 first-attempt passes, 0 failures, 2 retry recoveries, 0 skips**, 45 cases in 1.3 minutes. It includes the mapped-photo workflow in addition to the 44 selected acceptance cases. [Exact command](validation/2026-11-07-ux/final-chrome-command.json) and [per-case outcomes](validation/2026-11-07-ux/final-chrome-results.json) are retained. Repaired layout screenshots/measurements above were refreshed from this run; published captures remain the original macOS 27.2 evidence.

The two current Chrome retry recoveries were `photo-mapping-workflow.spec.ts` — **operator maps a photo, issues it, and the customer proves placement on the mapped photo** (browser closed during `locator.check`, 1.888s; retry passed in 4.125s), and `unified-editor.spec.ts` — **one editing workspace preserves canvas, areas and logos at 1440×900** (browser closed during `locator.fill`, 0.416s; retry passed in 1.725s). Browser-process output included macOS display-link/GPU diagnostics. These observations do not establish a cause. A separate serial, no-retry, trace-enabled rerun passed both first attempt (**2/2**, 9.3s); [its results](validation/2026-11-07-ux/final-chrome-recheck-results.json) supplement rather than erase the recorded flakiness.
