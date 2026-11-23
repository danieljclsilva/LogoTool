# Jacket workflow follow-up

The 18 November 2026 trial used front and back photos of a hi-vis freezer jacket and a GLB of a similar hi-vis jacket. It found a reproducible photo handoff failure, ambiguous selection in both editors, and friction receiving a confirmed return. The plan starts at build `8fd3587` on `codex/jacket-ux-followup`.

## 1. Repair photo handoff

- Trace stable view identity from fresh photo intake through measurement, package issue, customer preview and the operation document. Use product, variant, stable view ID and image identity consistently. Preserve old side-keyed manifests, option fallback and stale-mapping checks. Display labels can change without breaking the mapping.
- Render supplied views by their saved labels and show only artwork mapped to each view. Keep the diagram fallback for invalid or missing mappings, with short customer copy and detailed operator diagnostics.
- Surface unavailable proofs with the affected product, option and view at issue time. Keep a deliberate diagram-only handoff available when appropriate.
- Acceptance starts in a fresh operator job with two synthetic photos, distinct marks and safe areas. The shipped offline HTML must open with switchable Front and Back photos, each with its own mark. Confirm a change and verify the returned revision, candidate digest and both operation-document views. Check old packages, missing/invalid mappings and renamed view labels.

## 2. Keep operator photo placement in context

- Scope area outlines, handles and artwork to the current photo or explicitly selected diagram. Selecting a placement should bring its view into context, with support for several placements on one view and custom views.
- On desktop, keep artwork selection and placement controls beside the canvas. On narrow screens, preserve a usable canvas and a clear route back from the form. Unify the placement entry and carry forward the active artwork and area.
- Acceptance covers 1440 × 900 and 390 × 844, foreground and off-view placements, adding a second visually similar mark, resizing, undo and persisted millimetre values.

## 3. Synchronize 3D editing

- Front and Back controls should keep the visible model side and edited placement aligned. When a side has no available placement, show that state and prevent unintended edits to the prior selection. Keep orbit, zoom and pan independent of saved placement dimensions.
- Keep view controls discoverable across setup and placement. Group zoom buttons on mobile and give clear feedback when an attempted safe-area rectangle leaves the mesh.
- Acceptance uses front and back placements, multiple placements on the same side and an empty side. Compare the customer values and saved placement IDs after changing sides and using the camera. Capture desktop and narrow views. Investigate the real GLB Chrome closures independently and record any reproducible host/browser conditions.

## 4. Simplify issue and return review

- Let **Open customer response** start from the landing page. Verify the office copy and return before applying changes. Make the trusted job identity and product inclusion visible before adoption, restore them for a new review job when available, and preserve deliberate inclusions in an existing job. Handle mismatched IDs and cancellation without partially changing the current job.
- Keep issuing identifiers and the two file roles clear. Use compact success feedback and preserve warnings where a decision is needed.
- Acceptance covers fresh and existing sessions, matched and mismatched files, cancellation, disclosure of any omitted placements, confirmation revision and deterministic candidate export.

## Verification and delivery

Run `npm run typecheck`, `npm test` and the affected Playwright suites against the built station and generated package over offline `file://`. Exercise both self-contained and ZIP delivery, compare exported physical values and capture operator/customer screenshots. Replay the two real-product trials locally using the original private evidence. Record OS, actual browser/version, viewport, offline requests, page and console errors, and visual results. Actual offline Windows Chrome and Edge remain the delivery gate. Keep private assets and QA files out of Git. Each phase requires Codex diff review and behavior verification before commit or push.

## Phase 1 checkpoint

The first slice restores flexible photo view bindings in the customer editor and shared operation-document evaluator. Selecting a mapped view opens its photo and selects a placement in that area. The fallback diagram remains available when the binding is invalid. Issue-time proof readiness and the remaining phases are pending.

Independent verification passed on macOS 27.3 arm64. Typecheck and the build passed, all 885 Node tests passed, and 17 focused offline Playwright checks passed in bundled Chromium 156.0.8078.4. A fresh freezer-jacket photo job in Chrome 157.0.8103.51 displayed the correct logo on each customer photo and both proofs in the operator sheet. The 2 mm customer edit survived confirmation, reopening and staff adoption. The candidate digest matched confirmed revision 3. The run used offline `file://` at 1440 × 900, with a 390 × 844 customer layout spot check and zero HTTP(S) requests, console errors or page errors. The real-product evidence remains local. Actual offline Windows Chrome and Edge are still pending.

## Phase 2 checkpoint

The operator can switch front and back using the photo tabs or the placement list. The photo and selected placement follow each other. The stage renders only regions and artwork with a verified mapping to that photo and projects each area with its own calibration. Desktop details sit beside the photo. At 390 × 844 the panel is reachable and the page stays within the viewport. Direct artwork placement and the manual form still have separate entry points.

OpenCode delivered the initial view-scoping work and regression test. Codex stopped the delegated run at its time budget, then corrected the active editor layout, exposed the photo tabs and verified bindings and interaction in the integrated worktree.

On macOS 27.3 arm64, typecheck and build passed, along with 885 Node tests and 12 focused tests in offline bundled Chromium 156.0.8078.4. The real freezer-jacket replay in Chrome 157.0.8103.51 reproduced the overlapping outlines on the baseline. The updated build showed one correct outline and mark on each side, kept the panel beside the desktop stage and showed no horizontal overflow at 390 × 844. The real offline run completed at 1440 × 900 with zero HTTP(S) requests, page errors or console errors. The customer confirmation kept the 2 mm edit and the candidate matched its digest.

Artwork-entry consolidation, issue-time proof readiness, phases 3–4 and real offline Windows Chrome and Edge remain pending.

## Phases 3–4 checkpoint

Multi-photo artwork cards now open the placement form with the chosen artwork and active view preselected. Issuing a package warns when a view will use the measured diagram. The landing page opens a customer return directly. Staff can verify the issued identity and product options before adopting the return, and a fresh job restores that scope. Existing jobs keep their selected scope.

Front and Back now select a logo facing the customer. An empty side clears the editing fields until the customer chooses a logo. Setup keeps the presets under View to preserve canvas space, and the zoom pair stays together on narrow screens.

On macOS 27.3 arm64, typecheck, build, 885 Node tests, 13 focused offline bundled Chromium checks and eight focused offline branded Chrome checks passed. Six broader browser cases also failed at the same step on the baseline commit `8fd3587`. They cover invalid footprints, zero placements, primary span, direct model-only issue, legacy photo rows and five named photo views.

The original jacket photos completed single-file and extracted ZIP round trips in Chrome 157.0.8103.51. A comparable hi-vis 3D model completed an offline round trip in bundled Chromium 156.0.8078.4 using the office package from the calibrated operator run with the corrected customer runtime. An isolated Chrome 157 replay confirmed front and back logo selection on that real model. Each completed round trip preserved the customer’s 2 mm edit and confirmed digest through operator review. The private evidence records 1440 × 900 runs, 390 × 844 spot checks, and zero HTTP(S) requests, page errors or console errors on the completed paths.

Actual offline Windows Chrome and Edge acceptance and production calibration remain open. The earlier multi-context Chrome closures have no established cause.

## 23 November verification

OpenCode updated the named-photo intake checks. Codex completed the operator and return checks, restored the compact setup toolbar after measuring the canvas regression, and made wrong-office-copy feedback actionable before comparing the package assets. The archive checks also verify the versioned issue metadata and the original artwork bytes.

The build, typecheck, all 885 Node tests and 23 targeted offline Playwright cases passed on macOS 27.3 arm64 in Chromium 156.0.8078.4. The targeted run included all six previously failing operator cases and both customer delivery formats, including fresh-station review and wrong-office-copy handling. Separately, 14 archive and new-project cases and three model or print preview checks passed. The browser checks used offline `file://` contexts and their test-defined viewports, including 1440 × 900 and 390 × 844 for the new placement paths.

The wider Chromium run before those corrections passed 259 of 281 cases. Six remaining failures also reproduced on the untouched baseline. These cover two 1440 × 900 layout checks, enlarged canvas height at the 768-pixel tablet viewport, two visual product setup checks and a placement tray timeout. The two drag and restore cases passed in an isolated rerun. The four-measurement print and export case passed after the reopen test waited for the loaded job and opened the placement panel. Eleven targeted cases passed in the branded Chrome batch. A twelfth passed alone after Chrome closed during the batch.

The real-package rerun used the supplied jacket front and back photos in single-file HTML and extracted ZIP on Google Chrome 157.0.8103.51, and a comparable hi-vis GLB in single-file HTML on bundled Chromium 156.0.8078.4. All three runs started from fresh operator intake and went through customer confirmation, office reopening and candidate export. In each, the chest stayed fixed, the back moved 2 mm in X, and the candidate digest matched the confirmation. The completed runs reported zero page errors, console errors or HTTP(S) requests on macOS 27.3 arm64. Desktop runs used 1440 × 900 with narrow checks at 390 × 844. The visual review exposed internal calibration IDs in customer copy, which were removed from the mapped-photo status. Fourteen photo handoff and mapping cases passed after the wording change across bundled Chromium and branded Chrome.

The real-package release gate is still offline `file://` acceptance in Windows Chrome and Edge. Production sign-off also requires verified physical measurements.
