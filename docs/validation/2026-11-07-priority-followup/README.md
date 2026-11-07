# Follow-up acceptance evidence

Read the [audit](../../product-inclusion-followup-2026-11-07.md) for decisions,
results and remaining gaps. Every asset and fixture in this folder is synthetic.

- `run-manifest.json` records final commands and scope.
- `tested-files.json` records SHA-256 hashes of all 17 changed source/test files.
- `chromium-results.json` includes all 263 cases and each attempt.
- `chrome-results.json` includes all 58 selected cases and the three retry recoveries.
- `chrome-closure-recheck-results.json` records the three isolated traced rechecks.
- `failure-comparison.json` and `.csv` account for all 27 previously failing cases.
- `remaining-failures.md` lists all 18 remaining failures and observed blockers.
- `closure-comparison.json` records all 90 controlled baseline/reviewed/handler-off executions.
- `fit-verdicts.json` records both pure-kernel synthetic geometry verdicts.
- `baseline-guidance-measurements.json`, `chromium-measurements.json` and
  `chrome-measurements.json` preserve guidance and layout measurements.
- PNGs show initial viewports and below-fold full pages, plus normal/enlarged
  long-status and phone-tool states. Their filenames match measurement records.

The raw runner output and trace ZIPs remain in the local task evidence directory.
The historical reviewed-tree evidence is preserved in `../2026-11-07-ux/`.
