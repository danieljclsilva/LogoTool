# Internal Builder (Phase 11)

The guided Builder creates new drafts from bundled prepared definitions or
opens an existing local validated `.logo-project`. It uses the existing domain, customer editor,
return-import and operation-document contracts. No Odoo connection, upload or
schema finalization is involved. The Builder never sends files anywhere:
operators download files and attach them to their normal handoff manually.

## Start and issue

Run `npm run build`, then open `dist/internal-builder.html` directly with the
network disabled. For a synthetic demonstration, choose **Create a project**; no project file
is required. To exercise Open, choose `dist/trusted-issued.logo-project`. All fixtures and calibrations
used in tests are synthetic; optional raster reference photos and artwork
thumbnails are visual aids only.

The header offers two modes: **Prepare a project** and **Review a return**.
Preparation starts on **Start**, a guided sequence of one task at a time:

1. **Start.** Two paths with no technical file input required: the primary
   **Create a project** button starts a genuinely new draft from the bundled
   example catalogue, and the secondary **Open an existing project**
   disclosure (collapsed by default) loads a project file supplied for the job.
   Creating never uploads or opens an old customer job: it clears customer
   name, job reference, prepared-by, instructions, placements,
   confirmation/review histories and baseline references, then assembles a
   fresh revision-1 draft with a new local project ID from prepared product
   definitions. A failed create or open leaves the current project and outputs
   unchanged with an actionable error; a successful start moves on to Choose
   items. A new-source action stays easy to find. Keyboard works throughout.
2. **Choose items.** Products, their options and logos are checked by default
   with plain readable names; the created draft shows **Example products —
   not for production.** next to the list. Product and nested option toggles
   keep the original selection semantics; multiple logos and zero logos are
   supported. **Add a customer logo** imports a new PNG/JPEG/WebP image from
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

The bundled creation catalogue embeds explicit prepared definitions only —
currently the three example products in `examples/products/` plus the two SVG
marks in `examples/logos/` (byte-identical to those files, `synthetic=true`
on the issued draft) — built by `scripts/build-package-preview.mjs` into
`<script id="__logoBuilderCatalogue">`. It never ships an old customer job,
history, instructions or confirmation, and no production catalogue is
claimed. Add-logo artwork ships as referenced `original` bytes within the
same project-package limits as any other asset.

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
customer file** action delivers the selected format. A secondary advanced file
(project-only in self-contained mode, configurator-only in hybrid mode) and
the standalone return reviewer live behind disclosures; they are for special
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
are never approved here. The operation document from the exact candidate
revision and digest is available through **Preview operation document** and
remains printable, with print CSS intact. The primary action is **Print / save PDF** (browser Print /
Save as PDF path; native print-dialog settings and printer scaling require
operator review); the secondary action is **Save production data** (the actual
deterministic candidate JSON, with its file format noted in the advanced
detail). Candidate JSON and operation documents always remain
`candidate-pending-review`. Attach the returned project, candidate and checked PDF
manually to the ticket/BoM as appropriate; the Builder performs no Odoo writes
and records no approvals.

The handoff summary identifies the actual return, baseline and candidate
filenames and PDF steps.

**Save full reviewer** saves a separate inline HTML page for internal
decisions and revised customer proposals. Open it offline and select the saved
baseline and return. Its existing approval/reconfirmation rules still apply.
Downloading it does not open it. The Builder's embedded preview itself does not record internal decisions.

## Remaining gates

All fixtures/calibrations are synthetic. Optional raster reference photos and
artwork thumbnails are visual aids. Real calibration, physically mapped garment
artwork rendering, curved mapping, authenticated review, finalized production/Odoo
contracts and direct production PDF generation remain pending. Browser Print /
Save as PDF is the current document export. Actual Windows Chrome/Edge offline
`file://` delivery remains untested. See `offline-testing.md` for development
acceptance evidence.
