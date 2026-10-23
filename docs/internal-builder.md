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
network disabled. **Create a project** starts a genuinely empty draft: no
products, no logos, no example content — nothing is pre-selected, so nothing
synthetic can leak into a real job. To exercise Open with synthetic data, open
an explicit fixture package (tests build one from `examples/products/` plus the
`syn-mark` logos) or choose `dist/dev/trusted-issued.logo-project`. All fixtures and calibrations
used in tests are synthetic; optional raster reference photos and artwork
thumbnails are visual aids only.

The header offers two modes: **Prepare a project** and **Review a return**.
Preparation starts on **Start**, a guided sequence of one task at a time:

1. **Start.** Two paths: the primary **Create a project** button starts a
   genuinely new EMPTY draft (no products, no example content), and the
   secondary **Open an existing project** disclosure loads a project file
   supplied for the job. Creating never uploads or opens an old customer job:
   it clears customer name, job reference, prepared-by, instructions,
   placements, confirmation/review histories and baseline references, then
   starts an empty revision-1 draft with a new local project ID and no
   products at all. A failed create or open leaves the current project and
   outputs unchanged with an actionable error; a successful start moves on to
   Choose items. A new-source action stays easy to find. Keyboard works
   throughout.
2. **Choose items.** Nothing is pre-selected: the operator adds a real product
   first (**Add product from staged files** — one 3D model, one flat image, or
   assigned side-view images), then ticks only what the customer needs.
   Product and nested option toggles keep the original selection semantics;
   multiple logos and zero logos are supported. **Add a customer logo** imports a new PNG/JPEG/WebP image from
   this device through the real file chooser (2 MB pre-read bound, header +
   native decode validated); nothing is uploaded. The import keeps exact
   original bytes with a collision-safe ID, a readable name, `original` role
   and pixel dimensions only (never millimetre sizes or calibration), is
   selected automatically, and leaves prior state untouched on invalid,
   disguised, oversized or unreadable files. **Choose specific setups** is an
   advanced disclosure for preparation subsets only. A summary shows counts
   for the actual selection, and invalid selections (for example no products)
   are reported here. Continue moves to Customer details without needing job
   identity yet. Back and step tabs never change selections or outputs.

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
   alone is refused, never inferred from pixels). The created calibration,
   region (safe area defaults to the measured rectangle) and provisional
   mapping are committed atomically; the variant is linked automatically.
   Regions are shared geometry: editing one updates every linked option
   (stated up front and in the save confirmation), while anchors stay
   per-option. Model-only products show the actual 3D model on a white stage
   (orbit only, never a calibrated surface). **Add or replace a side photo**
   attaches an image to the selected existing product without recreating it.
   Choose its side and whether it applies to the current option or the whole
   product, then choose a local PNG/JPEG/WebP. A replacement is identified before
   choosing the file; it starts unmeasured and retires only its own photo mapping.
   Original image bytes, the model, other views and canonical measurements remain
   intact. Set the new photo's physical reference visually, then save a prepared
   master to retain the setup outside the browser session. Generated customer
   files become stale after a photo change and must be regenerated. Whole-product
   intake can be refused where only an option-specific presentation scope exists;
   use the indicated option scope instead. Raw mapping rows, prepared-JSON import and master
   save live under the single **Advanced product setup** disclosure.
3. **Customer details.** Only Customer name, Job reference and Prepared by are
   visible. The unique issue project ID is generated automatically as a fresh
   local ID: it never reuses the source ID, stays stable across step and mode
   navigation, and is reused for repeated generation with unchanged input. An
   explicit new-ID action and an editable ID field with a uniqueness note live
   behind **More options**, alongside the package format; manual overrides are
   kept, while empty or invalid IDs are rejected. The format defaults to the
   recommended self-contained HTML; the ZIP alternative is also behind More
   options. The single primary action is **Create customer file**, with
   field-specific validation. Success moves on to Save & send. Inputs lock
   during asynchronous work and stale async tokens are discarded.
4. **Save & send.** Exactly two files with plain purposes: **Save office copy**
   (the retained issued baseline for later return checks — save it before
   closing, because browser memory is lost on reload) and **Save customer file**
   (the delivery in the selected format, sent to the customer manually).
   The step shows the generated job/customer summary and human file sizes;
   exact internals live in the **File details** disclosure. Editing a selection or job detail
   invalidates the generated outputs consistently; switching tabs or modes
   alone does not.

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

In the Builder (Choose items → Import a prepared product definition), the
file validates before anything changes; a failed import keeps the previous
project. The pure kernel only format-checks the evidence digest — the Builder
then hashes the exact bytes it will package and compares against the supplied
digest before committing (stale async hashes are discarded, mismatches fail
atomically). Imported products arrive with zero placements and provisional,
pending-review calibration wording — never production-approved. The verified
sidecar plus the original export ship as `prepared/` package evidence assets
on issue; stale confirmation/review never survive because issuing always
creates a fresh revision-1 draft. Synthetic fixtures demonstrating the flow
live in `e2e/fixtures/bridge-area-bundle.json`, `bridge-labels.json` and
`prepared-bridge-product.json` (the last is script output, pinned by test to
equal fresh conversion); the offline roundtrip — including tampered-digest
rejection and obsolete-hash discard — is covered by
`e2e/prepared-product-import.spec.ts`.

Limitations (not production calibration): planar frames only (no curved/3D
mapping); all variants of one import share the single inspector calibration
recorded in the evidence (setup groupings, not independently measured
variants); real garment measurements, curved-surface behavior and operator
sign-off remain separate gates.

## Return review and ticket/BoM preparation
**Review a return** is separate from preparation and never shows
source/identity panels. It guides Office copy, then Customer return, then
Check & prepare. The office-copy chooser comes first and is never hidden
behind an advanced disclosure: in a fresh session, choose the saved office
copy file first, then the returned file. The retained original and the
customer-returned file are clearly distinguished; a loaded saved baseline
never implies a customer delivery exists. Switching modes alone preserves
valid state, while replacing the baseline invalidates the old review and
generated deliveries per current semantics. Invalid baseline/return files
leave the previous good state with a visible error (including
baseline-project mismatches).

Check & prepare shows readable filenames, the exact changes
(products/placements, instructions, zero placements) and the customer
confirmation/fit status before any action. Detailed diffs stay in a contextual
disclosure; unconfirmed or unsafe returns stay explicitly pending review and
are never approved here. The ONE branded operation sheet (A4 landscape:
business identity, sizes, selected anchor-to-edge dimensions, department
instructions only) is available through **Preview operation document** and
remains printable, with print CSS intact. The primary action is **Print / save PDF** (browser Print /
Save as PDF path; native print-dialog settings and printer scaling require
operator review); the secondary action is **Save operator data** (the minimal
operator JSON: same business data, no ids or digests). **More tools → Save diagnostic data**
provides the deterministic candidate JSON for advanced diagnosis. Candidate JSON always remains
`candidate-pending-review`; the printed sheet carries no digest, revision or
review-status text beyond a concise draft badge when work is unfinished.
Attach the returned project, operator data and checked PDF
manually to the ticket/BoM as appropriate; the Builder performs no Odoo writes
and records no approvals.

The handoff summary identifies the actual return, baseline and candidate
filenames and PDF steps.

**Revise proposal** (optional, in Check & prepare after the operation-sheet
and decision blocks) edits one placement's geometry plus the project note and
applies them as a new customer update through the same validated return
state — no second application, no re-import. The new update clears the
current confirmation and needs the customer to reconfirm before any approval.
**Save revised proposal** downloads the `<job>-r<rev>-proposal.logo-project`
file for the customer. **Review decision** (optional office bookkeeping,
same section) records the office decision for the current update with the
same confirmation/fit gates the reviewer enforced; approval stays internal
bookkeeping, never a production release. **Save reviewed return** keeps the
decided return with the office copy. A developer-only standalone reviewer
page remains under `dist/dev/` for engineering tests; it is not staff
workflow.

## Remaining gates

All fixtures/calibrations are synthetic. Optional raster reference photos and
artwork thumbnails are visual aids. Real calibration, physically mapped garment
artwork rendering, curved mapping, authenticated review, finalized production/Odoo
contracts and direct production PDF generation remain pending. Browser Print /
Save as PDF is the current document export. Actual Windows Chrome/Edge offline
`file://` delivery remains untested. See `offline-testing.md` for development
acceptance evidence.

### Pick production dimensions visually

In Review a return → Check & prepare, use **Pick on diagram** on a logo
measurement. Click its named anchor and then the logo edge on the product
photo. Review the proposed distance and Direction, then **Save measurement**.
Use **Add another** for another distance. Escape or Cancel leaves the row
unchanged. Advanced retains keyboard-friendly anchor, edge and direction controls.

The picker uses the saved view mapping and original raster artwork. Without a
valid photo mapping it clearly shows a millimetre region schematic. Picking
selects existing physical geometry; it does not calibrate a photograph or approve
production accuracy.
