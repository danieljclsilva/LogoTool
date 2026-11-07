# Excluded-product placement reproduction

Observed on merged c180a41 before repairs, offline Chromium on macOS.

1. Create a job and add calibrated products A and B. B becomes the editor focus.
2. Add artwork.
3. Uncheck B in Prepare job while A stays included.
4. Enter logo placement with the editor still focused on B.
5. Add a placement, then issue the included subset.
6. Inspect the issued project. The UI showed the placement but the customer file has zero placements.

The native F12 test reproduced expected placement count 1 versus actual 0. The full JSON, trace and pre-fix regression source are retained in the local task evidence directory. The tracked follow-up audit records this result.

Chosen behavior after reproduction: block new placement creation for an excluded product or option, explain its exclusion and how to include it or choose an included product. Preserve explicit inclusion choices and focus independence. Guard the actual mutation as well as the visible button.
