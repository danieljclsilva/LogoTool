# Remaining full-suite failures

Each case failed on reviewed `c180a41` and on this follow-up, including its retry. Shared outcome does not establish a shared root cause. The JSON preserves both runs’ attempts and the historical cause separately.

| ID | Spec and case | Current observed blocker |
| --- | --- | --- |
| F19 | `multiview-viewer.spec.ts` — model-only package offers honest 3D with a rendered model and side-tab availability | Availability assertion expects presentation/model.glb. The actual explanation omits that internal path. |
| F20 | `multiview-viewer.spec.ts` — replacement model bytes and an intervening image proxy keep the honest 3D pane current | Availability assertion expects presentation/model.glb. The actual explanation omits that internal path. |
| F21 | `new-project.spec.ts` — create customer journey adds a new raster logo and reviews the return | Both attempts reach the 30-second test timeout. The prior hidden customer-width cause remains a hypothesis for this run. |
| F29 | `operator-workflow.spec.ts` — calibrated photo overlay tracks canonical dimensions; unmapped views stay diagram | Expected two legacy pw-view-tab controls, received zero. Shared-workspace view contract remains unresolved. |
| F31 | `operator-workflow.spec.ts` — direct model-only job: calibrated diagram placement without any photo | Pick A on model exists but is hidden when clicked. The Measure panel has not been opened. |
| F32 | `operator-workflow.spec.ts` — invalid footprint stays scoped: actionable issue, complete print blocked, draft marked | Placement row exists but is hidden after Back to placements. |
| F33 | `operator-workflow.spec.ts` — primary span calibration drives the photo overlay with no Advanced mapping | Finish safe area button cannot be found in the current photo workflow. |
| F34 | `operator-workflow.spec.ts` — zero-placement option stays present and prints its explicit statement | Expected product card remains hidden after Add opens the product editor. |
| F36 | `placement-ux-regression-a.spec.ts` — placement UX: tray provisional preview, unified lock, unblocked drag (1280x900) | Both attempts time out at 120 seconds. Retry also reports context-close teardown failure. Earlier hidden Measure-control cause is not independently re-established by this run. |
| F40 | `presentation-assets.spec.ts` — Builder prunes unselected reference images and preserves the selected image through delivery and return | Both attempts time out at 30 seconds while filling hidden customer width-mm. The fill call log identifies the hidden control. |
| F41 | `presentation-assets.spec.ts` — fixed product, artwork, area and method do not become redundant selectors | Customer width-mm remains hidden when the test expects it visible. |
| F42 | `presentation-assets.spec.ts` — guided primary actions create zero and repeated placements without duplicates | Both attempts reach the 30-second test timeout. Prior hidden width-mm navigation cause remains a hypothesis for this run. |
| F44 | `product-photo-intake.spec.ts` — five named views calibrate, save, reopen, issue, customer places, review agrees | Existing-view rename input is hidden when filled. |
| F45 | `product-photo-intake.spec.ts` — in-place named rows: legacy views keep working, slug views at byte level | Product files context panel intercepts the Front view tab click. |
| F51 | `station-entry.spec.ts` — fresh-copied station issues both customer formats offline with no repo dependency | Both attempts time out at 30 seconds and report context-close teardown errors. Fresh-copy entry/focus state remains unresolved. |
| F58 | `visual-operation-dimensions.spec.ts` — four select-based measurements across two logos print and export | Both attempts time out at 240 seconds. The earlier placement-row scope explanation remains unresolved. |
| F60 | `visual-product-setup.spec.ts` — shared region: one safe-area edit reaches both variants, anchors stay per-variant | Safe area (4) button cannot be found in the current named-area workflow. |
| F61 | `visual-product-setup.spec.ts` — visual setup: upload → guided measure → draw + anchors → save → job roundtrip → review | Workspace status is empty when the test expects No product yet. |

The timeout-associated context-close errors in F36 and F51 are retained. They do not establish that the browser closed before the timeout. The controlled Chrome comparison reproduced zero closures.
