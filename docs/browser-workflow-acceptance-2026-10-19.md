# Browser workflow acceptance — 18–19 October 2026

Codex exercised the application through the user's native Google Chrome UI,
using local file pickers, controls, downloads and the actual print dialog.
Only synthetic fixtures and newly generated synthetic artwork were used.
This is macOS development evidence; it does not establish the Windows release
gate or physical production readiness.

## Environment and method

- macOS Darwin 27.2.0 arm64; installed Chrome 155.0.8059.80.
- Native window screenshots: 2880 × 1738 device pixels. No mobile emulation
  was used for the native walkthrough. DevTools was docked for offline and
  console inspection; this reduces the available page width.
- Built local HTML opened directly through `file://`; DevTools Network showed
  `Offline` for customer, reviewer and inspector checks. Unfiltered inspector
  requests contained only the local HTML. Native observations supplement the
  maintained suite's explicit offline contexts and zero-HTTP(S) assertions.
- The separate Playwright CLI refused `file://` navigation. Its guard was left
  intact. The user then explicitly selected native Chrome, which opened the
  local files normally. The repository's required `@playwright/test` suite
  remained the deterministic acceptance check.
- OpenCode v2 with `opencode-go/muse-spark-1.3-contributor` implemented the
  maintained journeys and the narrow guidance fix. Codex reviewed the changes
  and independently checked the resulting browser behavior and artifacts.

## Native operator/customer round trip

1. Created a fresh Builder project, selected the synthetic tee variants and
   imported the prepared bridge jacket through its file input. Added a local
   240 × 120 PNG containing only synthetic QA artwork.
2. Entered synthetic customer/job/operator details, generated a self-contained
   customer file, and downloaded both it and the retained office copy.
3. Opened the downloaded customer HTML, selected the imported jacket and the
   uploaded logo, entered a position and size, and reviewed the fit. Added
   project instructions, applied them, confirmed revision 3, and downloaded
   the customer return.
4. In a fresh Builder tab, loaded the retained office copy followed by that
   actual return. Checked the before/after measurements and instructions,
   downloaded candidate JSON, and inspected the operation document with its
   positioning diagram and original raster artwork.
5. Used Chrome's actual Print / Save as PDF dialog. The resulting five-page
   PDF was rendered with Poppler and all five pages visually inspected:
   identity/revision/status, zero-placement variants, physical measurements,
   coordinate conventions, calibration reference, diagram and artwork were
   present and readable. This PDF is the revision-3 document, paired with its
   revision-3 JSON, not a later-revision document.
6. Changed the logo to an intentionally unsafe 500 × 250 mm footprint.
   Confirmation became disabled and the earlier confirmation stopped counting.
   Corrected it to 60 × 30 mm and explicitly reconfirmed revision 5.
7. Added a second copy of the same artwork at an independent position,
   40 × 20 mm. Confirmed revision 6, saved, reopened the exact return through
   the customer file picker, and checked both dimensions and the retained
   current confirmation. Staff review showed both placements.
8. Downloaded and opened the full reviewer HTML. Loaded the retained office
   copy and return, recorded a synthetic internal workflow review, and saved
   the reviewed package. Then recorded changes requested, proposed a 2 mm
   change to the first logo's X coordinate, and downloaded revision 7.
9. Opened that proposal in the customer editor. The revision-6 confirmation
   was explicitly stale. Reconfirmed revision 7 and saved its return. Staff
   loaded it against the original office copy, recorded a new synthetic
   workflow approval, and downloaded the reviewed project and candidate JSON.
   Production status remained `candidate-pending-review` throughout.

Independent parsing of all three native candidate JSON downloads matched each
digest to its exact customer return (revisions 3, 6 and 7). The later proposal
preserved both placements and the original artwork. Nothing was sent by email
or uploaded.

## Native upstream inspector check

Opened the inspector offline and ingested the tracked synthetic block GLB.
A session for a different asset was correctly rejected with an asset-hash
mismatch. Loaded its matching synthetic transformed GLB and calibration session
through the UI; the application recomputed a consistent scale of
94.58033737310733 mm per model unit and kept it pending review.

Authored a new planar region from anchors A/B/C with a 0.01 mm off-plane
tolerance, a 100 × 100 mm safe polygon, and a fitting 20 × 10 mm footprint
centred at (30, 30) mm with 15° clockwise rotation. Inspected the rendered
model/anchors/footprint and downloaded the actual area bundle. Converted this
download with the local converter, an explicit synthetic label sidecar, and
the exact model SHA-256. Imported its prepared product into a fresh Builder
project, issued/downloaded a customer file, and placed/confirmed/saved a logo
in its `Native front` region. Imported products correctly started with zero
placements rather than silently copying inspector layout drafts.

Customer and full-reviewer console inspections showed zero messages. Inspector
console inspection showed four performance diagnostics (forced reflow and
requestAnimationFrame handlers, 109–425 ms), with no application exception
observed. These diagnostics are recorded rather than described as a silent
console. DevTools also reported form/accessibility improvement notices; this
walkthrough is not a complete accessibility audit.

## Finding and correction

The native walkthrough found misleading new-placement guidance: after editing
numbers, the page directed the user to `Apply my changes`, which was disabled
until a placement existed. New-placement guidance now names the available
guided add path for the current step. Existing-placement and project-note edits
retain their Apply guidance. Button gating, geometry and revision behavior are
unchanged. The maintained workflow tests cover both guidance cases.

## Maintained acceptance and remaining gates

`e2e/user-workflow.spec.ts` follows one coherent job per delivery format:
Builder creation/import/issue → downloaded self-contained HTML or extracted
hybrid ZIP → multiple/repeated logo placements and variants → unsafe-fit
correction → confirmation invalidation/reconfirmation → download/reopen →
fresh staff baseline review → candidate/document checks → revised proposal →
customer reconfirmation → final internal workflow review. It also checks
invalid/wrong-baseline preservation, desktop and 390 × 844 mobile layouts,
and zero HTTP(S), page and console errors across all pages. Screenshots,
downloaded artifacts and OS/browser/version/viewport/offline metadata accompany
each run. No timeout increases, forced disabled controls or application-state
injection are used in the passing tests.

Final independent commands and results are recorded in `docs/offline-testing.md`.
Local detailed evidence is retained in ignored
`.opencode/user-journey-2026-10-18/`; native downloads remain in Downloads.

Actual Windows Chrome/Edge offline acceptance, physical measurement and
calibration, garment surface mapping, verified operator approval and the final
Odoo production contract remain unverified. No live Odoo calls, customer data,
credentials, uploads, publishing, installs, commits or pushes were used.
