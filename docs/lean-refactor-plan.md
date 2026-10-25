# Lean operator workflow refactor

Baseline: `ea554df` (25 October 2026). Codex owns scope and acceptance;
implementation uses OpenCode `opencode-go/muse-spark-1.3-contributor`.

The user authorized starting the refactor after the validated implementation
was committed. No backward compatibility is required: there are no users.
This overrides compatibility requirements in the earlier workflow spec.
The checkpoint also exists locally under ignored `.opencode/checkpoints/`.

## Intended result

Keep the existing three-step interface and its behavior. Reduce duplicate
state and obsolete paths rather than move the same code into more files.
Use one plain editable job record and small functions. Keep the existing pure
geometry/calibration core, framework, package dependencies and shared document
renderer. Do not add stores, service classes, event buses or a new framework.

Editable project geometry, assets, inclusion, operator authoring and selection
must have explicit owners. Derive review/export snapshots from that state.
An issued approval baseline is historical evidence, not another editable job:
retain its independent identity and validation. Do not merge it into the live
project, invent a return or manufacture customer confirmation.

## Sequence and ownership

One OpenCode lead owns source edits. Each batch stops for Codex review before
the next starts; no parallel source writers across shared state.

1. **Live job state.** Consolidate the live source/job lifecycle and duplicated
   authoring state in `src/ui/internal-builder/main.ts`, using a minimal plain
   record/helper module where useful. Migrate actual consumers and delete the
   replaced variables/synchronization paths. Preserve dirty/pending-edit guards,
   asynchronous generation checks and atomic failed-open rollback. Do not add
   a wrapper while retaining both authoritative copies. No UI changes.
2. **Placement mutations.** Route edits through one transaction boundary;
   preserve one revision per logical change, no-op behavior and pending edits.
3. **Document and approval adapters.** One document snapshot/export path.
   Approval consumes current placements and independently validated evidence.
4. **Obsolete path deletion.** Remove superseded wizard DOM, handlers, formats
   and fixture aliases after all retained callers have been migrated. A hidden
   element or an audit's estimated line range is not proof of dead code.

Batch 1 is authorized now. Later batches require Codex's review of the actual
preceding result; the lead must not roll automatically into the full rewrite.
Do not consolidate calibration editors or remove the customer-editor bundle
as part of batch 1. Do not change physical/domain schemas or file contracts
unnecessarily. Future fixture changes must follow the chosen current format;
old fixtures do not justify preserving obsolete readers.

## Acceptance and limits

- Preserve Images/3D exclusivity, arbitrary named views, original assets,
  calibrated millimetres/frames, named safe areas and 0..N placements.
- Preserve direct Prepare → Placements → Review, actual PDF/print, saved job
  reopen, selection scope, deterministic unchanged saves/issue generation,
  genuine approval baseline/tamper checks and provisional production status.
- Preserve offline `file://`, zero HTTP(S) requests and actual error probes.
  macOS checks do not establish Windows Chrome/Edge delivery readiness.
- Record removed symbols and **actual net production line changes** per batch.
  Prefer deletion and fewer state owners; no arbitrary LOC claim or cosmetic
  shortening. Review any growth before proceeding.
- Run affected domain/UI checks per batch, then one full final gate after the
  refactor. Do not repeat broad suites per edit. Keep failing-run evidence;
  fix actual failures without weakening geometry, counts or safety assertions.
- No new features, UI polish, installs, Odoo calls, customer/private data,
  uploads or publishing. OpenCode must not commit or push.

Baseline evidence: 778 unit checks, 185 Chromium checks and 10 affected Chrome
checks passed; Codex independently passed 12 workflow/print checks and inspected
the three screens at 1280×900 and 390×844. Windows delivery and physical
production verification remain outstanding.

## Batch 1 review — 25 October 2026

Codex reviewed the integrated session migration and required corrections for
arbitrary identifier keys, Save snapshots and asynchronous Open installation.
The live job now owns project/assets, authoring, selection and dirty/edit state;
historical issued/return evidence remains independent. No UI changes were made.

Lead checks: typecheck; 788 unit checks before the correction pass; then 24
focused corrected unit checks and 21 affected offline Chromium journeys.
Codex independently passed the 24 focused units, four customer-return journeys,
and browser experiments holding an old Save across a newer Open and holding
an old Open while a newer Open wins. No stale download or dirty-state clearing
occurred. Prepare/Placements/Review were inspected at 1280×900 and 390×844,
offline Chromium 156.0.8078.4 on macOS; zero errors or HTTP(S) requests.

This is an accepted structural checkpoint, not completion of the leaner-code
goal: production code currently grows by **267 lines** (main −241, session
module +502, existing core helper +6). Full-suite evidence before corrections
is not presented as a fresh full gate. No commits or pushes were made.

Next, prioritize deletion of superseded operator wizard glue over additional
extraction. A single lead may remove only old routes/handlers whose retained
callers have been accounted for, preserving the existing three-step interface,
current optional approval branch, file inputs and any reused intake/setup DOM.
Do not add a new transaction framework or mechanically split more files.

## Obsolete wizard deletion review — 25 October 2026

The first refactor pass is reviewed: live job state is consolidated and the
superseded operator issue/return wizard, duplicate baseline/return state,
handlers, authoring desk, preview host and dead hooks have been deleted.
Save/Open, reused product setup/intake nodes, optional customer approval and
the shared operation document remain. Existing tests now reopen through the
real Open job control and explicitly discard dirty edits where required;
physical, tamper, exact-placement and deterministic-output assertions remain.

Codex verified that the accepted batch-1 session/core files are unchanged by
this deletion batch, reviewed the production and test changes and corrected
the lead's line accounting (its claimed incremental totals used HEAD instead
of the saved batch-1 checkpoint). Actual production counts:

| Measure | Lines |
| --- | ---: |
| Batch 1 growth | +267 |
| Deletion batch versus saved batch 1 | −3,543 |
| Combined production change versus `ea554df` | **−3,276** |
| Main UI file before / after | **10,340 / 6,767** |

The lead's final full offline Chromium suite passed 185/185. Codex's final
`npm run typecheck` passed and `npm test` passed **791/791**. The independent
installed-Chrome run of operator-workflow, new-project, user-workflow and
operation-sheet-print passed 28/29; the primary-span case reported
`browserContext.close: Target page, context or browser has been closed` during
cleanup, with macOS display-link/task-policy messages. That unchanged case
passed in isolation (1/1). This is a combined-run caveat, not a clean 29/29
claim or proof of the closure's cause. No assertion was weakened or skipped.

Independent rendered inspection reopened a synthetic job, navigated all three
steps, selected a real placement and checked the print action at 1280×900 and
390×844. There were no page/console errors, HTTP(S) requests or horizontal
overflow. Controlled browser experiments held an old Save across a newer Open
and an old Open across a newer Open; the newer job and its dirty state survived
and the stale Save produced no download. Logs/scripts/screenshots are local:
`/tmp/logotool-lean-final-{typecheck,units,chrome,chrome-recheck,visual,races}.log`,
`/tmp/logotool-operator-{prepare,placements,review}-{desktop,mobile}.png`.

Environment: macOS 27.2 arm64, Node 26.10.0, Playwright 1.64.0, bundled
Chromium 156.0.8078.4, installed Chrome 155.0.8059.85, built HTML directly
over `file://` with networking disabled. Browser-plugin tools were absent
from the actual tool inventory; repository Playwright was used. Actual
Windows Chrome/Edge, native print dialogs and physical production remain
unverified. Other audit opportunities (calibration-editor consolidation and
obsolete format-reader removal) were not included in this pass.

All implementation writers have stopped. Codex removed one trailing blank
line after review; no functional code changed after the acceptance runs.
The reviewed source, including untracked files, is recoverable from a local
ignored checkpoint. No commit or push was made and no further batch starts
automatically from this review.
