# Product inclusion and editor follow-up — 7 November 2026

## Review correction after `5b7bae6`

The pre-merge concern is repaired. Both the workspace creation actions and final commit boundary use `isPlacementCreationAllowed`. A selection-read failure now produces the shared inclusion-unavailable message and blocks creation. Save stops before packaging instead of persisting empty inclusion metadata. Review blocks document output when inclusion cannot be read. Valid unrestricted standalone callers retain their existing behavior.

Review now names omitted existing placements by product and option, with an exact count. Re-including the option removes its line. Shared operator option labels also distinguish unnamed options. The summary is separate from the canonical document and export data.

The existing `revealCustomerControl` helper repairs F21, F40, F41 and F42 by opening the size disclosure. F51 now uses the current shared workspace chooser and opens placement details. Its complete fresh-copy flow issues both delivery formats. These checks retain file-content, approval, deterministic-byte and physical assertions.

Independent final validation passes typecheck and **881/881 Node tests**. The complete offline Chromium suite has **253 first-attempt passes, 13 failures, zero retry recoveries and zero skips across 266 cases**. Every remaining failure also failed at `5b7bae6`. The five targeted workflow failures now pass. All three new browser regressions pass, covering omitted-placement summaries and selection-read failure at both the workspace and final commit boundary, with disabled creation, blocked Save and unchanged saved placement counts.

Installed Chrome passes **30/30 focused cases**, with zero retries needed. These cover all cases in `new-project`, `presentation-assets`, `station-entry` and `product-inclusion`. Both browser runs use built files through offline `file://` on the macOS environment recorded below. The complete case/attempt list, comparison of all 18 previous failures and frozen source hashes are in [the review correction results](validation/2026-11-07-priority-followup/inclusion-rule-review-results.json). Raw logs and screenshots remain in the local task evidence directory.

The new Review line was additionally rendered and visually inspected at 1280×720 and 390×844, with no horizontal overflow, console/page errors or HTTP(S) requests. The synthetic fixture includes one product and explicitly reports the other product's two omitted placements.

The suite remains red. The overflowing-toolbar cue and compact phone-header menu remain design follow-ups. Earlier intermittent browser closures remain unresolved despite this clean focused Chrome run. Actual Windows Chrome/Edge offline validation and an unaided staff usability trial remain open before customer use.


Review base is merged commit `c180a416fbecd6f6329ca68f1386b19b5b4dc7bd`, whose tree matches reviewed `4448e65`. Changes are isolated on `codex/product-inclusion-followup` for review.

## Review, plan and decisions

The pre-fix offline reproduction excluded product B while keeping editor focus on B, added a logo and issued the included subset. The source showed a placement and the issued file contained zero placements. The native F12 assertion reproduced expected 1 versus actual 0. The [minimal reproduction](validation/2026-11-07-priority-followup/minimal-reproduction.md) was recorded before implementation.

The chosen policy blocks new placements on an excluded product or option. A persistent message names the excluded scope and explains how to include it in Prepare job or choose an included scope. Add, Place and Duplicate follow the same policy. Submit callbacks recheck current inclusion, and the central commit boundary rejects placement-count increases in excluded configurations. Existing placements remain visible and editable. Explicit inclusion and independent editor focus remain separate controls.

Implementation proceeded through reproduction, inclusion guards and exported-file regression coverage, controlled browser-closure comparison, guidance measurement, synthetic geometry adjudication and responsive control design. An OpenCode Contributor lead delegated bounded tasks. Codex reviewed the integrated changes, repaired integration issues and independently ran final validation.

## Product focus and inclusion

Three new cases in `e2e/product-inclusion.spec.ts` cover excluded-product recovery with an issued-file placement check, exclusion after opening Add including a queued stale callback, and editing existing excluded placements followed by re-inclusion and duplication.

F12 now explicitly chooses an included product before adding. F30 likewise selects the included jacket and reopens the visible placement panel when required. F43's independent Open focus check already passed. Its later actions targeted a checkbox in the hidden Prepare panel and a removed legacy product chooser. The test now enters the appropriate step and asserts the shared workspace chooser. These test corrections retain issued subset, saved placements and reopen assertions.

## Browser-closure comparison

Installed Chrome ran three closure-prone cases available on the original baseline, ten times per condition. Conditions were original `e583941`, merged reviewed `c180a41`, and the same reviewed source with only the staff `beforeunload` registration removed. Ten rounds rotated condition order. Each three-case batch used a fresh worker, one worker, zero retries and offline `file://`. Browser runs were serial.

All **90 executions passed**, with zero browser closures. Each condition passed 30/30. The prior intermittent closure cause remains unresolved because it did not reproduce. The handler-off condition is a diagnostic snapshot. Snapshot hashes, exact case names, settings and all attempts are in [closure-comparison.json](validation/2026-11-07-priority-followup/closure-comparison.json).

## Guidance at 1280×720

A real Polygon Finish error with a roughly 400-character area name reproduced clipping in the reviewed 16px status row. The revised desktop guidance row reserves 48px, uses 12px text and 16px line height, and fits the longest Rectangle hint and this generated error in both normal and enlarged views. A longer error exercises focus and keyboard scrolling. Point additions retain a stable canvas within each active tool.

The [baseline measurements](validation/2026-11-07-priority-followup/baseline-guidance-measurements.json) and screenshots preserve the before state. Final measurements and screenshots are included alongside the acceptance results.

## Six fit workflows

The prepared fixture has a safe rectangle from −100 to 100mm horizontally and −80 to 80mm vertically, plus an exclusion from 10 to 20mm on each axis. A 50×30mm logo centred at (15,15) intersects that exclusion. The existing kernel correctly returns `footprint overlaps exclusions[0]`. Moving its centre to (−40,−30) yields a safe verdict. The [fixture and pure-kernel evidence](validation/2026-11-07-priority-followup/fit-verdicts.json) records both footprints, coordinate frame and calibration reference.

The six workflows now assert the invalid visual state and the preserved exact technical text `Fits: no — footprint overlaps exclusions[0]`. Confirmation and complete-document guards remain asserted. Four workflows also needed their product/option helper updated to the current shared chooser. Geometry rules and physical assertions are preserved.

## Phone controls

At widths up to 700px, a visibly labelled native Tool picker exposes Rotate model, Edit outline, Rectangle and Polygon. Only the active tool's authoring fields appear. Camera and display controls open through View. Escape closes that panel while preserving drawing points and enlarged mode. These controls retain 44px targets and visible text.

The normal phone viewport is checked before scrolling at 390×844, with at least 180px of canvas visible while idle and drawing. Original normal 60%-of-900px and enlarged 45%-of-viewport guards remain in the existing workspace cases. Picking stability is measured within a tool. Phone tool transitions deliberately add or remove the contextual row.

The canonical layout audit records the following heights with the page at scroll position zero.

| Viewport | Mode | Tool state | Canvas height | Visible above fold |
| --- | --- | --- | ---: | ---: |
| 1440×900 | normal | idle | 567.0px | 567.0px |
| 1440×900 | normal | active-drawing | 567.0px | 567.0px |
| 1440×900 | enlarged | idle | 644.2px | 644.2px |
| 1440×900 | enlarged | active-drawing | 644.2px | 644.2px |
| 768×1024 | normal | idle | 665.6px | 477.9px |
| 768×1024 | normal | active-drawing | 665.6px | 477.9px |
| 768×1024 | enlarged | idle | 589.7px | 589.7px |
| 768×1024 | enlarged | active-drawing | 589.7px | 589.7px |
| 390×844 | normal | idle | 394.0px | 338.1px |
| 390×844 | normal | active-drawing | 394.0px | 290.1px |
| 390×844 | enlarged | idle | 539.7px | 539.7px |
| 390×844 | enlarged | active-drawing | 491.7px | 491.7px |

The separate model-only phone test measures 338.1px visible while idle and 290.1px during drawing. Different header and product metadata produce different layouts, so the evidence includes both fixtures.

## Live demo check

Native Google Chrome Incognito opened the [cache-busted live demo](https://danieljclsilva.github.io/logotool-demo/?v=c180a41). After Create job, its visible second step read **2 Set up & place logos**. The [observation record](validation/2026-11-07-priority-followup/demo-private-check.json) distinguishes this label check from offline package acceptance.

## Validation recorded at `5b7bae6`

The complete Chromium run has **245 first-attempt passes, 18 failures, zero retry recoveries and zero skips**, across 263 cases. All 18 failing cases also failed in the reviewed run, which had 231 passes and 27 failures across 258 cases. The nine targeted previously failing cases now pass, as do all five new cases. The full suite remains red.

The [case-by-case comparison](validation/2026-11-07-priority-followup/failure-comparison.json), [CSV](validation/2026-11-07-priority-followup/failure-comparison.csv) and [remaining-failure table](validation/2026-11-07-priority-followup/remaining-failures.md) retain every previous/current failing case and each attempt. They distinguish observed blocking symptoms, historical candidate causes and unresolved triage. F36 and F51 retain context-close errors following timeouts. These messages do not establish a spontaneous browser closure before the timeout.

Installed Chrome ran **58 focused cases** with one worker and one retry. There were **55 first-attempt passes, three retry recoveries and zero persistent failures**. The three recoveries were browser-closure errors in the direct-images journey, desktop polygon-stability case and desktop layout audit. All three passed a subsequent isolated, traced, zero-retry run. The original three flaky outcomes remain recorded. Their logs contain macOS display-link errors, which do not establish the cause. The 90-pass controlled comparison therefore does not resolve the later intermittent closures.

Typecheck passes. The final `npm test` build and 866 Node tests pass. The [complete Chromium results](validation/2026-11-07-priority-followup/chromium-results.json), [focused Chrome results](validation/2026-11-07-priority-followup/chrome-results.json), [traced recheck summary](validation/2026-11-07-priority-followup/chrome-closure-recheck-results.json) and [rendered measurements](validation/2026-11-07-priority-followup/chromium-measurements.json) identify every executed case and attempt. The [test source hashes](validation/2026-11-07-priority-followup/tested-files.json) identify the frozen acceptance tree.

All acceptance fixtures are synthetic and use built files through offline `file://`. Environment is macOS 27.3 (26C5035r), arm64, Node 26.10.0, Playwright 1.64.0, Chromium 156.0.8078.4 and installed Chrome 156.0.8078.74. Passing acceptance cases enforce empty console/page-error and HTTP(S)-request probes.

Actual Windows Chrome/Edge validation remains open. Edge is absent on this Mac. Physical calibration, production approval and the previously recorded broader delivery gates remain unresolved. This review branch does not establish readiness for customer use.
