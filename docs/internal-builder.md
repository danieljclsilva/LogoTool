# Internal Builder (the Logo Station)

The guided Builder is the single staff entry: run `npm run build`, then open
`dist/station/Logo Station.html` directly with the network disabled. No other
staff HTML page is part of the delivery; developer-only inspection pages live
under `dist/dev/`.

The guided Builder starts empty and opens an existing local validated
`.logo-project`. It uses the existing domain, customer editor,
return-import and operation-document contracts. No Odoo connection, upload or
schema finalization is involved. The Builder never sends files anywhere:
operators download files and attach them to their normal handoff manually.
There is no demo content, example catalogue or pre-selected item anywhere in
the station or its generated packages; tests use explicit synthetic fixture
imports (see `e2e/visual-product-setup.spec.ts`).

## Start and issue

Run `npm run build`, then open `dist/station/Logo Station.html` directly with the
network disabled. The landing offers **Prepare an operational document**:
**Create job** starts a genuinely empty draft (no products, no logos, no
example content — nothing is pre-selected, so nothing synthetic can leak into
a real job), **Open job** loads a saved `.logo-project` job file, and
**Open customer response** jumps to the optional approval branch.
To exercise Open with synthetic data, open an explicit fixture package or
`dist/dev/trusted-issued.logo-project`. All fixtures and calibrations used in
tests are synthetic; optional raster reference photos and artwork thumbnails
are visual aids only.

The header offers **Save job**, **Open job**, **New job** (secondary job
actions) plus **Open customer response**. A persistence status sits directly
beside **Save job** in the header — a single `role=status` node that travels
with Save job into the unified editor command row — and reads
`Unsaved changes — not yet downloaded.` while dirty and
`Downloaded <fileName> — keep this file to reopen the job.` after download.
The download wording reports initiation only: the page cannot verify the file
was written, so it never claims "Saved". After create/open, ONE three-step
navigation runs the normal path — **1 Prepare job → 2 Set up & place logos
→ 3 Review document** — with
no parallel customer-packaging wizard. Back/step tabs preserve state and never
generate files; forward tabs enforce the same gates as the primary actions.
New job or opening a file with unsaved changes asks **Save job / Discard
changes / Keep editing** inline; only explicit Discard or a successful
save-and-continue replaces the job.

1. **Prepare the job.** Heading `Prepare the job`, intro `Add the products
   and artwork for this job.` Order: Customer + Job reference + Prepared by
   (three short inputs; names/refs may stay blank during setup, but review
   requires Customer and Job reference), Products, Logos. IDs never appear as
   normal editable fields.
   Products reuse the explicit Images/3D intake, arbitrary named views, Add
   product and set up, and the calibrated product workspace below; first
   empty product section shows intake open once. Each product card shows a
   thumbnail/model icon, product name, option count when >1, an `Include
   [name]` inclusion checkbox, a setup status (`Needs measurements`, `Needs
   safe areas`, `Setup saved` — configuration completeness, never production
   approval) and `Set up`. Logos are preview + name cards with an `Add logo`
   chooser; multiple and zero logos are valid. The primary
   **Set up & place logos** requires at least one included product and a
   structurally valid job; calibration gaps surface on Step 2, never here.
2. **Set up & place logos.** Heading `Set up & place logos` (single step/module title), with product /
   option selectors (hidden when single), named view tabs, and either
   calibrated photo overlays, a calibrated 3D product workspace, or the authoritative region-mm `Measured placement diagram`. Photo overlays appear wherever the
   exact scope (product + region + option + view + image + calibration) has a valid evaluated mapping: the primary
   two-click span calibration stages a provisional mapping automatically, and an explicitly reviewed Advanced mapping
   also qualifies. Provisional overlays carry the truthful warning `Provisional calibrated preview — verify physical
   measurements before production` and never auto-approve production geometry. With no valid mapping (unmapped views,
   trial-only or invalid mappings) the stage shows the diagram instead — millimetres always come
   from the region frame, never from pixels or mesh bounds. Each placed logo renders its actual original raster
   artwork inside the footprint (affine-mapped, beneath selection outlines; missing art keeps a labelled outline).
   Model-only products with current asset-bound setup evidence show the actual
   model and original raster artwork on its triangles. Drag artwork, or select
   **Move logo** and click the product; **Rotate**, **Front**, **Back**, **Fit**,
   zoom, **Enlarge workspace** and **Save job** stay inside the workbench. The
   enlarged view includes logo selection, dimensions and actions; on narrow
   screens **Logo details** opens that panel without leaving the product.
   Screen picks are converted through the saved region plane and reference
   scale, never pixels or mesh bounds. This remains a provisional planar
   physical mapping; surface-following artwork is a visual preview. Stale,
   missing or foreign model setup evidence never substitutes a guessed mapping.
   Editor action buttons and selects meet a 44px minimum with 14px text on
  desktop and narrow layouts, and the dashed drop-zone border meets 3:1
  contrast on white. `Add logo placement` opens an
   inline form (Logo, Safe area, Width/Height mm, Method); starting position
   is the region centre, never invented sizes. Selected-placement controls run
   Logo, Safe area, Width/Height, Keep proportions, Rotation, Placement
   measurements + Add measurement (anchor/edge/direction with visual picker),
   Duplicate/Remove, and Apply changes (visible only while edits are pending).
   Zero placements are valid. `Review document` requires valid structures and
   no unapplied edits; unsafe/incomplete placements may enter review with
   actionable issues but never masquerade as complete. Pending edits block
   review navigation, approval generation, printing and Save job until
   applied (Apply), discarded (Discard) or left alone (Keep editing).
3. **Review document.** Single heading `Review operational document` (no duplicated shell/module titles); the main
   column ALWAYS renders the actual shared operation-sheet renderer for the current canonical revision (no customer
   file, return, or confirmation is ever needed or invented). Desktop lays out the sheet preview left (2fr) with the
   contextual rail right (minmax 280px, 1fr); narrow viewports stack the sheet first, then the rail, with no
   horizontal scroll. Print renders the same sheet full-page with rail/title/chrome hidden. The rail holds the job summary, `Items to check`
   (each with a `Fix` link), staff-authored `Operational instructions`
   (customer notes stay read-only context), optional technique settings, the
   primary **Print / save PDF** (browser dialog + A4 stylesheet; disabled with
   blocking/incomplete items), a secondary **Print draft** for structurally
   valid but incomplete jobs (explicit DRAFT markings), **Save job** and
   **Back to placements**. Placement summaries (or adjacent `Edit [logo]`
   actions) return to Step 2 with the exact selection. Print CSS hides
   navigation/actions/inputs and the edit affordances; paper uses the same
   renderer as the screen.
4. **Optional customer approval (branch, not a fourth step).** Secondary
   **Send for customer approval** opens `Send for customer approval`: job and
   exact current-selection summary, format default self-contained HTML (ZIP
   under More options), one primary **Create customer file** built from the
   CURRENT operator placements (exact mm preserved), then the two-file
   handoff **Save office copy** + **Save customer file**. **Open customer
   response** (branch, landing, header) validates against the byte-exact
   issued baseline and opens a change summary with **Use customer changes** /
   **Keep current job** — no auto-merge. Staff geometry edits afterwards mark
   branch files stale per revision contracts.

**Save job** downloads one editable `.logo-project` with exact geometry,
original assets, presentation/calibration sidecars, selection, identity and a
versioned `operator/job-metadata.json` sidecar (operation-authoring metadata:
instructions, per-logo technique, measurement bindings bound to exact
identities, inclusion including selected-but-unused logos). Legacy files
without the sidecar open with empty metadata (never invented measurements);
scope changes mark dependent measurements unresolved, never silently rebind.
   The empty draft shows a single inviting intake block. **Add a customer logo**
   imports a new PNG/JPEG/WebP image from this device through the real file
   chooser (2 MB pre-read bound, header + native decode validated); nothing is
   uploaded. The import materializes exact original bytes into the live job
   (one revision) with a collision-safe ID, a readable name, `original` role
   and pixel dimensions only (never millimetre sizes or calibration), is
   selected automatically, and leaves prior state untouched on invalid,
   disguised, oversized or unreadable files. **Choose specific setups** is an
   advanced disclosure for deliberate preparation subsets only. A summary shows
   counts for the actual selection, and invalid selections (for example no
   included products) are reported with the exact gate text. Unchecking a logo
   that placements use keeps those placements visible and resolvable, warns
   explicitly, and only narrows future Add-placement choices.

   **Set up product (the visual workspace).** The main prepare path works
   directly on the product photo on a white stage: view tabs for the actual
   sides only (Front/Back/Left/Right), two tools — **Safe area** (draw a fresh
   polygon by clicks, drag/insert/remove corners, keyboard throughout) and
   **Anchor** (click to place named anchors, drag/rename/delete) — then ONE
   **Save product setup** that atomically persists the region safe area plus
   the scope's anchors (or neither) through a repackage-and-reparse commit.
   All geometry stays in region-frame millimetres; photo pixels are display
   only. A newly added product has no measurements: its views honestly report
   **no scale mapping**, and **Set up scale** opens the guided first-measured-
   region panel — click the 4 corners of a known rectangle, enter its real
   width AND height in millimetres, declare the orientation, and the panel
   solves the affine photo mapping through the existing solver (collinear or
   badly fitting corners are refused with actionable messages; one length
   alone is refused, never inferred from pixels). The primary flow is now the
   two-click reference (uniform scale, origin at A, +x toward B) with an
   UNCONFIGURED region — no safe polygon is invented; the operator draws
   named areas explicitly and saves once (see `calibration.md`). The
   rectangle path above stays as the advanced alternative (it still defaults
   the safe area to the measured rectangle — pre-existing, tested, and kept
   deliberately for that path). The created
   calibration, region and provisional
   mapping are committed atomically; the variant is linked automatically.
   Regions are shared geometry: editing one updates every linked option
   (stated up front and in the save confirmation), while anchors stay
   per-option. All staged named areas persist as sibling domain regions per
   scope (same frame/calibration); concurrent multi-scope edits are refused
   instead of silently merged. Model-only products are measured directly on
   the 3D surface in the model pane below (two-click surface reference plus
   named areas; no photos needed or accepted, and the view-image disclosure
   stays hidden for them). **Add or replace a view image** attaches an image
   to the selected existing Images product without recreating it. Views are
   named rows scoped to the selected product and option — each keeps its own
   human name — so choose the row (add a new named view or replace an
   existing one) and whether it applies to the current option or the whole
   product, then choose a local PNG/JPEG/WebP. A replacement is identified before
   choosing the file; it starts unmeasured and retires only its own photo mapping.
   Original image bytes, the model, other views and canonical measurements remain
   intact. Set the new photo's physical reference visually, then save a prepared
   master to retain the setup outside the browser session. Generated customer
   files become stale after a photo change and must be regenerated. Whole-product
   intake can be refused where only an option-specific presentation scope exists;
   use the indicated option scope instead. Raw mapping rows and master
   save live under the single **Advanced product setup** disclosure. There is
   no prepared-JSON import control in normal station UI: operators work from
   their own media plus guided setup, and reopen existing work with the
   ordinary Open action.

    **Model-only 3D setup.** A 3D model contains all viewpoints, so
    model-only products require NO images (photos cannot be attached to a
    3D-model product — a product is either Images or a 3D model): the
    staff-only 3D setup view (`src/ui/internal-builder/model-setup-view.ts`,
    mounted in the model pane) calibrates a uniform scale from a two-click
    A/B surface reference plus a real millimetre entry, then authors multiple
    NAMED safe areas directly on the model surface. Reference anchors are
    raycast mesh hits in asset coordinates — never pixels or bounds — and
    distances are straight-line chords, not surface arcs. Each safe polygon
    establishes its own region plane; the save commits a calibration record,
    one domain region per area (plane-projected ring) and a deterministic
    sidecar to the master. Editing or recalibrating the reference marks
    dependent areas stale until explicitly recomputed. Separate show/hide
    anchors, safe-areas and product-buttons toggles are display-only and
    never discard staged data. Limits: planar patches only (no curved
    mapping), one span proves no shape correctness, nothing here is
    production-approved. See `calibration.md`.
    Safe-area drawing has an immediate outline while the pointer is held and
    while clicked corners are incomplete. Only release/Finish validates and
    commits geometry. **Enlarge workspace** keeps the tools, reference controls,
    area list and Save inside one panel. **Measurements and safe areas** opens
    the internal settings drawer on narrow enlarged views. Escape closes the
    enlarged view and cancels any active gesture without changing geometry.
   The new issue project ID is minted in the approval branch (never the source
   ID, unique per issue) and stays stable across navigation; it is reused for
   repeated generation with unchanged input. The format defaults to the
   recommended self-contained HTML; the ZIP alternative sits under More
   options. The single primary action is **Create customer file**, with
   field-specific validation. Success enables the two-file handoff. Inputs
   lock during asynchronous work and stale async tokens are discarded.

The branch issue starts at revision 1 with the issued project ID. Source
confirmation, internal review and their histories are cleared; original source
files are unchanged. Customer/job/issuer labels are descriptive local data,
not authenticated identities. Only artwork referenced by selected logos ships
(plus artwork used by included placements, for integrity); unrelated
additional source assets are omitted. Selected bounded product-reference
images and their `presentation/preview.json` manifest travel with the
delivery and retained baseline, pruned to the issued configurations;
see `customer-project-workflow.md`. The current schema has no product-model
binary references; no real product asset mapping is claimed.

The station embeds NO example catalogue: the release build carries zero
example products, marks or demo UI (pinned by
`tests-ts/distribution-station.test.ts`). Tests that need example content
build an explicit synthetic fixture package from the same prepared
definitions (`examples/products/` plus the `syn-mark` logos) and open it
through the real source chooser — never preloaded, never demoed. Add-logo
artwork ships as referenced `original` bytes within the same project-package
limits as any other asset.

The issue starts at revision 1 with the issued project ID. Source
confirmation, internal review and their histories are cleared; original source
files are unchanged. Customer/job/issuer labels are descriptive local data,
not authenticated identities. Only artwork referenced by selected logos ships;
unrelated additional source assets are omitted. Selected bounded product-reference
images and their provisional `presentation/preview.json` manifest also travel
with the delivery and retained baseline; see `customer-project-workflow.md`. The current schema has no product-model
binary references; no real product asset mapping is claimed.

Self-contained delivery is `OPEN_LOGO_CONFIGURATOR.html` with the issued
project bytes embedded and automatically loaded: the customer opens it
directly, nothing to unzip. Hybrid delivery is `<JOB>.zip` containing
`OPEN_LOGO_CONFIGURATOR.html` and `<JOB>.logo-project`, which the customer
opens and loads with Choose Project or drag and drop. The primary **Save
customer file** action delivers the selected format, sent to the customer
manually. A secondary advanced file (project-only in self-contained mode,
configurator-only in hybrid mode) lives behind a disclosure for special
cases only. The saved office copy is byte-identical to the issued project in
either format. Regenerating identical input produces identical project, HTML
and ZIP bytes.

Changing a selection, identity or format clears generated downloads and the
return preview. Files are size-checked before reading, validated before
replacement and bounded by package/editor limits. Failed imports retain the
previous valid source/baseline/review. Core Builder limits are 64 products,
64 logos, 64 issued configurations and 256 characters per ID/identity field.

## Prepared products from inspector exports

An inspector calibration/region-area export becomes a Builder product through
a documented local conversion — never a hand-authored file:

```sh
npm run build   # the script imports the compiled kernel from dist/
node scripts/convert-area-bundle.mjs \
  --area-bundle <area-bundle.json> \
  --labels <bridge-labels.json> \
  --expected-asset-sha256 <64 hex chars> \
  --out <prepared-product.json>
```

The script runs the pure `buildPreparedProductFromAreaBundle` kernel over the
actual export: exact envelope-version/asset-hash match, locally recomputed
fit, explicit operator labels (product/variant/region/frame/method — nothing
invented), atomic rejection. Output is `{ product, sidecar, areaBundleText,
areaBundleSha256 }`; `areaBundleText` is the verbatim source export text
(strict UTF-8; a leading BOM is supported and preserved, anything else that
cannot round-trip byte-identically is rejected) and `areaBundleSha256` its
SHA-256, so original evidence (including named exclusion identities the
canonical schema cannot represent) travels byte-identically. Output refuses to
overwrite existing files, is written atomically (exclusive link-install), and
is capped at the shared Builder intake bound — oversized conversions fail with
an actionable error before anything is written.

In the developer path, the conversion output is assembled into an ordinary
saved project (validated append, exact-byte evidence-hash check, packaging)
and opened in the station with **Open an existing project** — the station
itself offers no prepared import. The pure kernel only format-checks the
evidence digest — the developer build then hashes the exact bytes it will
package and compares against the supplied digest before committing
(mismatches fail before the station ever sees them). Prepared products arrive
with zero placements and provisional, pending-review calibration wording —
never production-approved. The verified sidecar plus the original export ship
as `prepared/` package evidence assets on issue; stale confirmation/review
never survive because issuing always creates a fresh revision-1 draft.
Synthetic fixtures demonstrating the flow live in
`e2e/fixtures/bridge-area-bundle.json`, `bridge-labels.json` and
`prepared-bridge-product.json` (the last is script output, pinned by test to
equal fresh conversion); the offline roundtrip — including tampered-digest
rejection at the developer build — is covered by
`e2e/prepared-product-import.spec.ts` through ordinary Open.

Limitations (not production calibration): planar frames only (no curved/3D
mapping); all variants of one import share the single inspector calibration
recorded in the evidence (setup groupings, not independently measured
variants); real garment measurements, curved-surface behavior and operator
sign-off remain separate gates.

## Return review and ticket/BoM preparation

**Open customer response** (header, landing, or the approval branch) is the
only return path: there is no separate review mode. It asks for the saved
office copy first when none is loaded, then the returned file. The retained
original and the customer-returned file are clearly distinguished; a loaded
saved baseline never implies a customer delivery exists. Invalid,
oversized, tampered, or wrong-baseline returns are rejected atomically and
leave the active job and its outputs unchanged (including
baseline-project mismatches).

A validated response opens a change summary (geometry verdict, per-logo
millimetre before/after, customer notes as read-only context) with
**Use customer changes** (installs the exact validated content and opens Step
2 with placements rebuilt) and **Keep current job** (discards the check
without touching the job). No automatic merging. Office-authored measurement
bindings, anchors and technique whose identities still resolve are preserved
and distances recompute under changed logo geometry; changed or missing
scopes become unresolved. Confirmation freshness, atomic bad-response
rejection, deterministic bytes, review bookkeeping separation and draft
bound identity all hold on this path.

The reviewed return does not unlock the direct document: Step 3 Review always
renders the current canonical job (never a stale lastReturn), and staff must
author any still-missing placement measurements before complete print — or
use the explicitly marked **Print draft**. **Print / save PDF** prints the
actual current sheet (the same renderer as the screen preview; print CSS
excludes navigation/actions/inputs/edit affordances). **More output options**
holds **Save operator data** (the minimal operator JSON: same business data,
no ids or digests) and **Save diagnostic data** (deterministic candidate
JSON). Candidate JSON always remains `candidate-pending-review`; the printed
sheet carries no digest, revision or review-status text beyond a concise
draft badge when work is unfinished. Attach the returned project, operator
data and checked PDF manually to the ticket/BoM as appropriate; the station
performs no Odoo writes and records no approvals. Internal review decisions
stay optional Advanced bookkeeping, never production approval; a
developer-only standalone reviewer page remains under `dist/dev/` for
engineering tests, not staff workflow.

## Remaining gates

All fixtures/calibrations are synthetic. Optional raster reference photos and
artwork thumbnails are visual aids. Real calibration, physically mapped garment
artwork rendering, curved mapping, authenticated review, finalized production/Odoo
contracts and direct production PDF generation remain pending. Browser Print /
Save as PDF is the current document export. Actual Windows Chrome/Edge offline
`file://` delivery remains untested. See `offline-testing.md` for development
acceptance evidence.

### Pick production dimensions visually

In Step 2 (Set up & place logos), use **Add measurement** on a selected logo:
choose the named anchor, the artwork edge and the convention, optionally pick
anchor then logo edge on the calibrated photo overlay (**Pick on diagram**),
review the resulting mm distance, then **Save measurement**. Horizontal (dx)
needs a left/right edge and vertical (dy) a bottom/top edge — anything else
is refused with the reason shown; missing anchors route to the exact product
setup scope. Esc or Cancel leaves the row unchanged. The picker uses the
evaluated reviewed photo mapping where one exists (never invented from
pixels); without a valid reviewed mapping the authoritative measured
placement diagram stays the source of truth. Picking selects existing
physical geometry; it does not calibrate a photograph or approve production
accuracy.

### Scoped setup drafts

Switching product, option or side keeps that view's staged setup for the current
open project. Select an anchor or safe-area corner on the photo to reveal its
controls; **Precision** holds optional millimetre fields. Opening another project
starts a new session. Save a prepared master to keep completed setup on disk.

A safe area shared by several options is labelled beside Save. If another option
changes the saved area, an unedited area adopts that change while staged anchors
stay intact. Conflicting area edits block saving; **Reset to saved** reloads the
saved setup. Drafts are never silently applied to another option.

### Product cards

Tick a product's `Include [name]` box to include it in the document and
customer file; unticked products stay in the editable catalogue but are
omitted from scoped outputs. Operator surfaces never show internal variant
ids: an unnamed single option renders as the product name alone, and unnamed
options of multi-option products render as Option 1, Option 2 and so on
(display only — diagnostics and saved files keep exact ids). **Set up** opens its visual workspace without
changing inclusion. A single-option product includes that option
automatically; products with several options expose their actual choices. The
selection summary counts the effective options. Explicit setup unticks are
deliberate narrowing; untouched setups ride along automatically. Unchecking a
logo used by placements keeps those placements visible and warns explicitly.
Product thumbnails use the retained original photos on white.

## Independent intake verification — 24 October 2026

Codex reviewed the integrated Contributor implementation against the latest
operator feedback. The station presents one intake path with Images/3D radio
controls, mode-specific media fields and a primary Add product and set up
button. Prepared JSON import is removed from station onboarding; saved projects
still open normally. Named views retain stable identities when renamed.

Independent closing checks: `npm run typecheck` passed; `npm test` passed
758/758; `e2e/product-photo-intake.spec.ts` passed 4/4 in Chromium and 4/4 in
installed Chrome, sequentially with one worker. The real five-view journey
covers creation, measurement, isolated image replacement, renaming a measured
view without changing calibration, master reopen, both customer delivery
formats, customer placements and named operation-document output. The lead's
full Chromium run passed 173/173. Its broader affected Chrome run had two
browser-process/navigation failures, followed by passing isolated reruns;
that combined run remains caveated, not reported as all green.

Environment: macOS 27.2 arm64, Node 26.10.0, Playwright 1.64.0, Chromium
156.0.8078.4 and Chrome 155.0.8059.85; built HTML opened with `file://` in
offline contexts. Flow viewports include 1280×900 and 480×900; independent
visual checks also used 390×844. Tests assert zero application console/page
errors and zero HTTP(S) requests. Independent inspection confirmed the page
title, nonempty UI, mode-switch interaction, no error overlay and readable
intake controls at desktop/narrow sizes. Browser-plugin tools were absent from
the actual session inventory; repo-local Playwright was used per AGENTS.md.
Local logs are in ignored `.opencode/intake-ux-2026-10-24/`; independent intake
screenshots are `/tmp/logotool-intake-images.png`,
`/tmp/logotool-intake-model.png` and their mobile counterparts.

Windows Chrome/Edge offline delivery and physical measurement accuracy remain
unverified release/production gates. No installs, customer/private data reads,
Odoo calls, uploads, publishing, commits or pushes were performed.

## Independent Codex acceptance — 25 October 2026

Codex independently reviewed the exact `operator-workflow-ux-spec.md`
implementation and required integration, visual and output corrections before
acceptance. OpenCode Contributor performed the production implementation.
Codex tightened one fresh-model-reopen test probe to monitor actual errors and
HTTP(S) requests rather than asserting empty literals, and removed a test EOF
blank line; these validation-only changes were preserved by the lead.

Independent closing evidence:

- `npm run typecheck`: passed for app, viewer and e2e.
- `npm test`: 778/778 passed.
- `e2e/operator-workflow.spec.ts` plus `e2e/operation-sheet-print.spec.ts`,
  `--project=chromium --project=chrome --workers=1`: 22 checks (11 per browser).
  Closing results are retained in the local log below. Journeys exercise real
  image intake, primary calibration without Advanced mapping, raster artwork
  on calibrated photos/diagrams, stable placement geometry/orientation,
  measurements, technique settings, inclusion, direct review, saved-job reopen,
  model-only draft path, approval baseline/tamper handling and actual PDF output.
- PDF checks generate actual PDFs and assert page count equals rendered sheets,
  A4 landscape MediaBox, and meaningful output bytes; print-media checks exclude
  app controls. The new shell's trailing blank page was corrected; it was not
  a pre-existing renderer limitation. Native print dialog/printer settings and
  physical output remain unverified.
- The lead's full Chromium suite passed 185/185. Earlier broader Chrome runs
  had load failures followed by successful isolated/rerun results; that earlier
  combined-run caveat is retained, not erased by later passes.
- Independent rendered checks opened the built station, reopened a saved
  synthetic job, navigated all three steps and selected a real placement.
  Page identity/content, desktop and narrow layout, artwork rendering, no
  framework overlay and action states were inspected. No page/console errors
  or HTTP(S) requests occurred in those offline checks.

Environment: macOS 27.2 arm64, Node 26.10.0, Playwright 1.64.0, bundled
Chromium 156.0.8078.4, installed Google Chrome 155.0.8059.85. All acceptance
runs use built HTML directly via `file://` in offline browser contexts, with
synthetic files only. Viewports: 1280×900 and 390×844. Actual Browser-plugin
tools were absent; repository Playwright is the primary AGENTS.md workflow.
Logs and artifacts: ignored `.opencode/operator-workflow-2026-10-25/`, especially
`codex-final-pass-typecheck.log`, `codex-final-pass-unit.log`,
`codex-final-pass.log`, `codex-final-pass-artifacts/` and
`codex-final-pass-visual.log`. Independent screenshots are
`/tmp/logotool-operator-{prepare,placements,review}-{desktop,mobile}.png`.

The direct operator path never creates a fake return, baseline or customer
confirmation. Customer approval is optional and validated against a real
issued office copy. Physical calibration/production approval and actual Windows
Chrome/Edge offline delivery remain unverified. Model placements use supported
planar millimetre diagrams; unsupported curved mesh projection is not claimed.
Incomplete model placement references correctly keep the document in draft.
No installs, Odoo calls, private/customer data reads, external uploads,
publishing, commits or pushes were performed. All implementation writers are
stopped; the working tree preserves prior intake/calibration work.


### Integration closeout accepted — 25 October 2026

The fresh Contributor closeout lead stopped all writes after fixing chooser
membership (included scope plus live selection and authored placements) and
four disclosure-toggle test sites. No new features or refactoring were added.
Its final gate passed typecheck, 778/778 unit checks, 185/185 Chromium checks
and 10/10 affected installed-Chrome checks. This supersedes the earlier
176/185 regression run; earlier failed-run evidence remains retained.

Codex independently reviewed the chooser implementation and ran 12 affected
Chromium checks against the final built artifact (31.3 seconds): revision-1
issue generation; four print/document checks; direct images intake through
calibration, placements, measurements, technique, Save/Open and optional
approval; invalid-footprint and zero-placement output; and four customer
return journeys covering self-contained/hybrid files and fresh station copies.
These check exact installed placement counts, unchanged deterministic issue
regeneration, automatic new issue IDs after edits, rejection of manual ID
reuse, genuine baseline validation and actual PDF output. All 12 passed.
No source changed after the lead gate; this addition records evidence only.

Codex also reopened a synthetic saved job and inspected all three screens at
1280×900 and 390×844 in offline Chromium 156.0.8078.4 on macOS 27.2 arm64.
Page identity, rendered content, real placement selection, enabled print action,
readable wrapping and absence of horizontal overflow were checked. There were
zero page/console errors and zero HTTP(S) requests. Browser-plugin tools were
absent from the actual tool inventory; repo-local Playwright was used.
Independent logs: `/tmp/logotool-codex-closeout.log` and
`/tmp/logotool-closeout-visual.log`; screenshots:
`/tmp/logotool-operator-{prepare,placements,review}-{desktop,mobile}.png`.

The lead report is locally retained under the ignored
`.opencode/operator-workflow-2026-10-25/integration-closeout-result.md`.
A local recoverable checkpoint includes the binary Git patch and every
modified/untracked source file, with HEAD and SHA-256 manifest. No commit or
push was made. Refactoring has not started. Windows Chrome/Edge file delivery,
native print dialogs and physical production verification remain untested.

## Logo Station UX improvements — 7 November 2026

The reviewed plan covered unsaved-work protection, visible download status,
consistent step names, reversible intake switching, readable diagnostics,
editor controls and inline placement validation. The review confirmed the
step-label mismatch and the active-mode intake bug. The retained hidden
identity/format panel still supplies bound controls. Review diagnostics already
live inside the collapsed **More output options** disclosure.

The chosen Step 2 name is **Set up & place logos** throughout the stepper,
forward action, workspace heading and accessible label. The persistence line
travels beside **Save job** into the product editor. It wraps on narrow screens
and records the actual suggested filename using the exact strings documented
above. A successful download initiation describes browser behavior. Staff keep
the downloaded file to reopen their job.

Closing or refreshing a tab with a dirty job or pending placement edits invokes
the browser's unsaved-work warning. Chromium requires prior user activation to
show its native dialog. Clean jobs close directly. The existing in-app
Save/Discard/Keep editing guard handles New and Open.

Images and 3D intake keep their staged files across mode switches. **Add product**
uses the active mode's files, then releases both staged collections and their
thumbnail URLs after success. Removal, New and Open also release staged previews.
Failed operations retain the staged files for correction.

Failure alerts put a plain-language headline before collapsed **Technical details** containing the original diagnostic text. The details render as text.
The saved project remains available after a failed candidate validation.
Editor action controls have a 44px minimum height and 14px labels. The model
canvas adapts to the space below the toolbar and above Save, with a 180px
minimum. Enlarged views fit the controls and canvas to the viewport. Camera
and display controls use a horizontal scroll row when space is constrained;
on enlarged phones the editing/lighting controls also scroll horizontally.
Controls remain reachable with touch and keyboard focus at 44px minimum height.
Existing narrow-layout icons retain their accessible names; camera and text
actions keep their labels.
The desktop authoring row reserves room for Finish, Undo and Cancel even while
inactive, so switching drawing tools does not shift the canvas. Normal narrow
views still require page scrolling; the measured evidence distinguishes total
canvas height from its initially visible portion.
The dashed upload border uses `#5f6f7e` for contrast against white.

Codex reviewed and approved the WI-7 proposal before implementation. Invalid
placement sizes, rotation, centre coordinates, safe area and method show inline
errors with `aria-invalid` and `aria-describedby`. **Apply changes** is disabled
with a visible reason while the fields are invalid. Correcting values clears the
errors. Pending invalid edits continue to block save and review, and commit-time
validation checks the final candidate.

The synthetic offline regression suite covers native unload dialogs, filename
status and reopening, mode-specific package media and thumbnail cleanup,
escaped technical details, and invalid-field recovery. Acceptance results and
the Windows Chrome/Edge release gap are recorded in `docs/offline-testing.md`.
The follow-up [validation audit](ux-validation-audit-2026-11-07.md) includes
complete baseline/published/follow-up outcomes, all failing tests, exact focused
coverage and synthetic screenshots. Reference-span input preserves the matching
pointer release's fractional photo coordinates instead of rounded click
coordinates; this avoids introducing a small rotation into the calibrated frame.
