# Customer editor review — 15 November 2026

Reviewed `0579d39` through code inspection and an offline synthetic-model
walkthrough in Chromium. The existing customer-editor and model-proof suites
pass all 14 cases in this run, with two workers and zero retries. The issues
below concern behaviors those cases do not currently assert.

## P1 — Applied edits can be lost when closing or opening another project

After opening the synthetic model project, change width from 40 to 45 mm and
move focus out of the field. The status reports “Applied your changes as
version 2.” The applied version lives in memory until a draft or confirmed
return is downloaded. The page has no beforeunload guard. A cancellable
beforeunload probe returns false for prevention after this edit. Selecting the
original project again immediately restores width 40, clears undo history and
replaces the edited project without a discard decision.

Track content awaiting download alongside pending form edits. Warn on close
and offer a save/discard decision before installing a newly opened project.
Test both applied edits and incomplete numeric fields, and mark a download
clean only for the exact revision captured by that download. Relevant code is
`installMutation`, `loadProjectSource` and `savePackage`.
[Customer editor source](../src/ui/customer-editor/main.ts)

## P2 — Typing a height silently switches off Keep shape

With Keep shape checked, change the width to 45 mm. Both dimensions become
45 mm. Type height 30 mm. The checkbox immediately clears, and applying produces
45 × 30 mm. A customer editing the height while the control promises linked
width and height can distort the artwork unintentionally. The input handler
explicitly clears the lock and discards its ratio.

Apply height changes through the same locked ratio policy as width changes.
An explicit checkbox action can authorize independent dimensions. Add a
regression covering both axes, selection changes and save/reopen.
[Height input handler](../src/ui/customer-editor/main.ts)

## Evidence and limits

The [runtime results](validation/2026-11-15-round2-review/results.json) record the
40 → 45 → replacement 40 sequence, the unload probe and the ratio checkbox
transition. The [customer screenshot](validation/2026-11-15-round2-review/customer-desktop.png)
shows the edited synthetic project. Review covered the model-backed path and
existing automated customer journeys. An unaided customer trial, accessibility
scan and actual Windows operator-machine acceptance are pending.

The next implementation should address download-aware persistence guards and
symmetric proportion locking, then run the self-contained and hybrid customer
round trips with multiple products and zero/multiple placements.
